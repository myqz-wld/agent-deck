import { useEffect, useState, type JSX } from 'react';

interface Props {
  open: boolean;
  sessionId: string;
  /** 关闭对话框（取消 / 起 spawn 完成）。spawn 成功时 main 端会 emit session-focus-request
   *  让 App.tsx 自动 setView('live') + select(newSid)，此处不必额外 props。 */
  onClose: () => void;
}

/**
 * K3 hand-off preview dialog（plan mcp-bug-and-feature-batch-20260513 Phase 4c）。
 *
 * 双阶段流程：
 *   1) mount → window.api.handOffSummarize(sid) → 显示 textarea 可编辑 summary
 *   2) 用户审阅 / 编辑 → 点「起新 session 接力」 → window.api.handOffSpawn(sid, summary)
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
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // mount / 重开时拉一次总结。disposed flag 防 unmount 后 setState 报警。
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setSummary('');
    setError(null);
    setSummarizing(true);
    void window.api
      .handOffSummarize(sessionId)
      .then((result) => {
        if (disposed) return;
        setSummary(result.summary);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(`总结失败：${(err as Error).message ?? String(err)}`);
      })
      .finally(() => {
        if (disposed) return;
        setSummarizing(false);
      });
    return () => {
      disposed = true;
    };
  }, [open, sessionId]);

  if (!open) return null;

  const retrySummarize = (): void => {
    setError(null);
    setSummarizing(true);
    void window.api
      .handOffSummarize(sessionId)
      .then((result) => setSummary(result.summary))
      .catch((err: unknown) =>
        setError(`总结失败：${(err as Error).message ?? String(err)}`),
      )
      .finally(() => setSummarizing(false));
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
            LLM 已根据本会话最近 200 条活动生成「目标 / 已做 / 下一步 / 相关文件」结构化简报。
            你可以直接编辑下方文本，确认后会
            <span className="text-deck-text">起一个新 session</span>
            （cwd / agent / 权限模式沿用原会话），同时
            <span className="text-deck-text">自动归档原会话</span>。
          </p>

          {summarizing && summary === '' && (
            <div className="shrink-0 rounded bg-white/[0.03] px-3 py-2 text-[11px] text-deck-muted">
              🔄 正在用 sonnet 总结会话历史，通常 10-30 秒…
            </div>
          )}

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

          {error && (
            <div className="shrink-0 rounded bg-status-waiting/10 px-3 py-2 text-[11px] text-status-waiting">
              <div>⚠ {error}</div>
              {error.startsWith('总结失败') && !summarizing && (
                <button
                  type="button"
                  onClick={retrySummarize}
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
