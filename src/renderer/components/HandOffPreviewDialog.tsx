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
    return () => {
      // unmount / 重开 → 自增 seq 让 in-flight IPC 全部失效
      requestSeqRef.current += 1;
    };
  }, [open, sessionId]);

  if (!open) return null;

  const startSummarize = (): void => {
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
        if (cur !== requestSeqRef.current || capturedSid !== sessionId) return;
        setSummarizing(false);
      });
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (!summary.trim()) {
      setError('请填写接力简报（textarea 不能为空）');
      return;
    }
    setSpawning(true);
    try {
      await window.api.handOffSpawn(sessionId, summary);
      // 成功：main 端已 emit session-focus-request → App 自动切 detail。直接关闭对话框。
      onClose();
    } catch (err) {
      setError(`起新会话失败：${(err as Error).message ?? String(err)}`);
    } finally {
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
            📤 接力到新会话{summarizing ? '（总结中…）' : spawning ? '（起新会话中…）' : ''}
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
            点「开始总结」后，LLM 会基于本会话最近 200 条活动生成
            「目标 / 已做 / 下一步 / 相关文件」结构化简报（约 10-30 秒，单次会调用
            <span className="text-deck-text"> sonnet API</span>，按 token 计费）。
            你可以编辑后再确认起新 session（cwd / agent / 权限模式沿用 +
            <span className="text-deck-text">自动归档原会话</span>）。
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
              🔄 正在用 sonnet 总结会话历史，通常 10-30 秒…
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
                  : '总结将出现在这里，你可以编辑后再确认。\n\n如果总结失败，可在此手动写兜底接力简报，然后直接「起新 session」。'
              }
              className="min-h-[280px] flex-1 resize-y rounded border border-deck-border bg-white/[0.04] px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/20 disabled:opacity-50"
            />
          )}

          {error && (
            <div className="shrink-0 rounded bg-status-waiting/10 px-3 py-2 text-[11px] text-status-waiting">
              <div>⚠ {error}</div>
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
            {spawning ? '起新会话中…' : '起新会话接力 →'}
          </button>
        </footer>
      </div>
    </div>
  );
}
