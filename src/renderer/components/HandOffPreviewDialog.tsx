import { useEffect, useRef, useState, type JSX } from 'react';

interface Props {
  open: boolean;
  sessionId: string;
  /** 关闭对话框（取消 / 起 spawn 完成）。spawn 成功时 main 端会 emit session-focus-request
   *  让 App.tsx 自动 setView('live') + select(newSid)，此处不必额外 props。 */
  onClose: () => void;
}

/**
 * K3 hand-off preview dialog（plan mcp-bug-and-feature-batch-20260513 Phase 4c；
 * CHANGELOG_94 改：mount 不再自动调 LLM，改成显式「开始总结」按钮触发，
 * 避免用户误点 / hover 触发后浪费一次 sonnet 调用；
 * CHANGELOG_95 review fix：requestSeqRef + sessionId capture 替代 disposedRef，
 * 修 sessionId 切换 + dialog open 同时发生时旧 IPC 污染新会话状态的 bug）。
 *
 * 三阶段流程：
 *   1) mount → 显示空状态 + 「开始总结」CTA 按钮（不调 LLM）；用户可直接「取消」零成本退出
 *   2) 用户点「开始总结」→ window.api.handOffSummarize(sid) → textarea 可编辑 summary
 *   3) 用户审阅 / 编辑 → 点「起新 session 接力」 → window.api.handOffSpawn(sid, summary)
 *      → 成功后 main 端 emit session-focus-request 让 App 自动切到新 session detail
 *
 * 失败兜底：
 *   - summarize 失败：显示 inline error + 「重试」按钮 + textarea 仍可手动写兜底 prompt
 *   - spawn 失败：显示 inline error，textarea 状态保留让用户重试
 *   - 不允许 modal 内 close 中断 in-flight IPC（按钮 disabled），避免用户疑惑「点了但没反应」
 */
export function HandOffPreviewDialog({ open, sessionId, onClose }: Props): JSX.Element | null {
  const [summary, setSummary] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [hasSummarized, setHasSummarized] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** sequence counter：每次 startSummarize 自增 + 闭包捕获本次序号；resolve 时若不等于
   *  当前 ref 即「过期 IPC」（dialog 已 reset / sessionId 已切 / 用户连续点了多次开始总结）→ 静默 drop。
   *  替代原 disposedRef.current 单 boolean 方案（reviewer-claude H1 + reviewer-codex MED1 双方独立指出
   *  cleanup 设 ref=true 后新 effect 立刻置回 false → 旧 IPC resolve 仍能通过 guard 污染新 state）。 */
  const requestSeqRef = useRef(0);
  /** REVIEW_33 H7：同步入口守门 ref（比 React state 快 16-200ms）。
   *  问题：`setSummarizing(true)` / `setSpawning(true)` 走 React state 路径会被 batch
   *  16-200ms 后才生效，**这段时间内** button 仍未 disabled，用户双击 / 连续点按钮
   *  → 入口被多次进入 → 多次 IPC 起多次 sonnet 调用（按次计费）/ 多次 spawn SDK 子进程。
   *  修法：函数入口先看 ref，true 即静默 drop；ref 同步赋值无 React batch 延迟。
   *  重置走两个时机：(a) `open` / `sessionId` 变化的 reset effect；(b) finally 块 */
  const summarizeInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);

  // open / sessionId 变化（含初次 mount）→ 重置所有 state，**不**自动触发 summarize。
  // ++requestSeqRef 让任何 in-flight IPC 都被识别为过期。
  useEffect(() => {
    if (!open) return;
    requestSeqRef.current += 1;
    setSummary('');
    setError(null);
    setSummarizing(false);
    setHasSummarized(false);
    setSpawning(false);
    // REVIEW_33 H7：dialog reset 时同步清入口 ref，防上次 dialog 留下的 in-flight 标记锁死新 dialog
    summarizeInFlightRef.current = false;
    submitInFlightRef.current = false;
    return () => {
      // unmount / 重开 → 自增 seq 让 in-flight IPC 全部失效
      requestSeqRef.current += 1;
    };
  }, [open, sessionId]);

  if (!open) return null;

  const startSummarize = (): void => {
    // REVIEW_33 H7：同步入口守门，挡双击 race（React state setSummarizing(true) 16-200ms
    // batch 内 button 仍 enabled，用户连点按钮会让入口被多次进入起多次 sonnet IPC）。
    if (summarizeInFlightRef.current) return;
    summarizeInFlightRef.current = true;
    setError(null);
    setSummarizing(true);
    requestSeqRef.current += 1;
    const cur = requestSeqRef.current;
    const capturedSid = sessionId;
    void window.api
      .handOffSummarize(capturedSid)
      .then((result) => {
        if (cur !== requestSeqRef.current || capturedSid !== sessionId) return;
        setSummary(result.summary);
        setHasSummarized(true);
      })
      .catch((err: unknown) => {
        if (cur !== requestSeqRef.current || capturedSid !== sessionId) return;
        setError(`总结失败：${(err as Error).message ?? String(err)}`);
        // hasSummarized 不切 true：失败后 textarea 仍允许手动写兜底；error 触发 textarea 渲染 + 「重试总结」按钮 inline 显示。
      })
      .finally(() => {
        // 入口 ref 总是清（即使过期 IPC 也清，避免 reset effect 已先把它置 false 时 finally 重置无副作用）
        summarizeInFlightRef.current = false;
        if (cur !== requestSeqRef.current || capturedSid !== sessionId) return;
        setSummarizing(false);
      });
  };

  const submit = async (): Promise<void> => {
    // REVIEW_33 H7：同步入口守门（同 startSummarize），挡双击导致起两个 SDK 子进程
    // （比 setSpawning(true) 更快，无 React state batch 延迟）。
    if (submitInFlightRef.current) return;
    setError(null);
    if (!summary.trim()) {
      setError('请先填写接力简报');
      return;
    }
    submitInFlightRef.current = true;
    setSpawning(true);
    try {
      await window.api.handOffSpawn(sessionId, summary);
      // 成功：main 端已 emit session-focus-request → App 自动切 detail。直接关闭对话框。
      onClose();
    } catch (err) {
      setError(`起新会话失败：${(err as Error).message ?? String(err)}`);
    } finally {
      submitInFlightRef.current = false;
      setSpawning(false);
    }
  };

  const busy = summarizing || spawning;
  /** 「未点开始总结」初始态：显示 CTA + 说明，textarea 不渲染。
   *  CHANGELOG_95 review fix MED-1：加 `&& !spawning`。否则路径
   *  「summarize 失败 → 用户手写 textarea → 点起新会话」时：spawning=true / hasSummarized=false /
   *  error=null（submit 已 setError(null)），idle 误判 true → CTA 闪现 + textarea 消失。 */
  const idle = !hasSummarized && !summarizing && !error && !spawning;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag flex w-[480px] max-h-[85%] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-bg-strong shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-4 py-3">
          <h2 className="text-[13px] font-medium">
            📤 接力到新会话{summarizing ? '(总结中…)' : spawning ? '(打开新会话中…)' : ''}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            title={busy ? '请等待当前操作完成' : '取消'}
          >
            ✕
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto scrollbar-deck p-4">
          <p className="shrink-0 text-[10px] leading-relaxed text-deck-muted">
            生成一份接力简报(目标、已完成、下一步、相关文件),约 10-30 秒,会消耗一次模型调用额度。
            你可以编辑简报,确认后会打开新会话(沿用工作目录和权限设置),并自动归档当前会话。
          </p>

          {idle && (
            <button
              type="button"
              onClick={startSummarize}
              className="shrink-0 self-start rounded bg-status-working/30 px-3 py-1.5 text-[11px] text-status-working hover:bg-status-working/40"
            >
              ✨ 开始总结
            </button>
          )}

          {summarizing && summary === '' && (
            <div className="shrink-0 rounded bg-white/[0.03] px-3 py-2 text-[11px] text-deck-muted">
              🔄 正在总结会话历史,通常 10-30 秒…
            </div>
          )}

          {(hasSummarized || summarizing || error || spawning) && (
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={summarizing}
              rows={16}
              placeholder={
                summarizing
                  ? '正在总结…'
                  : '简报会显示在这里,你可以编辑后再确认。\n\n生成失败时,也可以手动填写后继续接力。'
              }
              className="min-h-[280px] flex-1 resize-y rounded border border-deck-border bg-white/[0.04] px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/20 disabled:opacity-50"
            />
          )}

          {error && (
            <div className="shrink-0 rounded bg-status-waiting/10 px-3 py-2 text-[11px] text-status-waiting">
              <div>⚠️ {error}</div>
              {error.startsWith('总结失败') && !summarizing && (
                <button
                  type="button"
                  onClick={startSummarize}
                  className="mt-1 underline hover:no-underline"
                >
                  重试总结
                </button>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-deck-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !summary.trim()}
            className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {spawning ? '打开新会话中…' : '打开新会话接力'}
          </button>
        </footer>
      </div>
    </div>
  );
}
