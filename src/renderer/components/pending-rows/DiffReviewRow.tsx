import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import type { AgentEvent, DiffPayload, DiffReviewRequest, DiffReviewResponse } from '@shared/types';
import { DiffViewer } from '../diff/DiffViewer';
import log from '@renderer/utils/logger';

const logger = log.scope('renderer-diff-review-row');

export function DiffReviewRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: DiffReviewRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const diffPayload = useMemo(() => buildPrDiffPayload(payload), [payload]);

  const respond = async (response: DiffReviewResponse): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      await window.api.respondDiffReview(agentId, sessionId, payload.requestId, response);
      onResolved(sessionId, payload.requestId);
    } catch (err) {
      logger.error('respondDiffReview failed', err);
    } finally {
      setBusy(false);
    }
  };

  const onClickRevise = (): void => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    void respond({ decision: 'revise', feedback: feedback.trim() || undefined });
  };

  const onFeedbackKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void respond({ decision: 'revise', feedback: feedback.trim() || undefined });
  };

  return (
    <li
      className={`min-w-0 rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={
            stillPending
              ? 'text-status-working'
              : wasCancelled
                ? 'text-deck-muted/70'
                : 'text-status-working/80'
          }
        >
          {stillPending
            ? payload.mode === 'merge-conflict'
              ? '🧩 待展示冲突解决'
              : '🧩 待展示差异'
            : wasCancelled
              ? '🚫 差异展示已取消'
              : '✅ 已处理'}
        </span>
        {payload.title && (
          <span
            className="max-w-[16rem] truncate rounded bg-white/[0.06] px-1.5 py-0.5 text-deck-muted/90"
            title={payload.title}
          >
            {payload.title}
          </span>
        )}
        {payload.filePath && (
          <span
            className="max-w-[18rem] truncate font-mono text-deck-muted/80"
            title={payload.filePath}
          >
            {payload.filePath}
          </span>
        )}
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond({ decision: 'approve' })}
              title="确认此片段并把结果返回给模型"
              className="rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认片段
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClickRevise}
              title={showFeedback ? '把反馈发给模型修改此片段' : '要求模型修改此片段（点击后可写反馈）'}
              className="rounded border border-deck-border bg-white/[0.06] px-2.5 py-0.5 text-[10px] text-deck-text hover:bg-white/[0.12] disabled:opacity-50"
            >
              提修改意见
            </button>
          </div>
        )}
      </div>

      {stillPending && isSdk && showFeedback && (
        <input
          type="text"
          autoFocus
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={onFeedbackKeyDown}
          placeholder="反馈可选；按 Enter 或再次点击“提修改意见”提交"
          disabled={busy}
          className="mb-1.5 h-7 w-full rounded border border-deck-border bg-white/[0.04] px-2 text-[10px] text-deck-text outline-none placeholder:text-deck-muted/70 focus:border-white/20 disabled:opacity-50"
        />
      )}

      {payload.instructions && (
        <div className="mb-1.5 rounded border border-deck-border/40 bg-white/[0.025] px-2 py-1 text-[10px] leading-relaxed text-deck-muted/90">
          {payload.instructions}
        </div>
      )}
      <div className="mb-1.5 rounded border border-deck-border/40 bg-black/20 px-2 py-1.5 text-[10px] leading-relaxed text-deck-text">
        {payload.rationale}
      </div>

      {payload.mode === 'pr' && diffPayload ? (
        <div className="h-80 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diffPayload} sessionId={sessionId} />
        </div>
      ) : payload.mode === 'merge-conflict' && payload.conflict ? (
        <ConflictReviewGrid payload={payload} />
      ) : (
        <pre className="max-h-64 max-w-full overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}

      {!isSdk && (
        <div className="mt-1.5 text-[10px] text-deck-muted">
          这是终端启动的只读会话，请回到原终端窗口处理
        </div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1.5 text-[10px] text-deck-muted/70">
          这次差异展示请求已取消
        </div>
      )}
    </li>
  );
}

function buildPrDiffPayload(payload: DiffReviewRequest): DiffPayload<string> | null {
  if (payload.mode !== 'pr' || !payload.pr) return null;
  return {
    kind: 'text',
    filePath: payload.filePath ?? payload.title ?? 'diff-presentation',
    before: payload.pr.before,
    after: payload.pr.after,
    metadata: {
      source: 'mcp-diff-presentation',
      beforeLabel: payload.pr.beforeLabel,
      afterLabel: payload.pr.afterLabel,
      diff: payload.pr.unifiedDiff,
      language: payload.language,
    },
    ts: Date.now(),
  };
}

function ConflictReviewGrid({ payload }: { payload: DiffReviewRequest }): JSX.Element {
  const c = payload.conflict!;
  const columns = [
    { key: 'ours', label: c.oursLabel ?? '当前', content: c.ours },
    { key: 'theirs', label: c.theirsLabel ?? '传入', content: c.theirs },
    { key: 'resolution', label: c.resolutionLabel ?? '建议结果', content: c.resolution },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {c.base != null && (
        <ConflictPane label={c.baseLabel ?? '共同基础'} content={c.base} className="max-h-36" />
      )}
      <div className="grid min-w-0 grid-cols-1 gap-1.5 lg:grid-cols-3">
        {columns.map((col) => (
          <ConflictPane key={col.key} label={col.label} content={col.content} />
        ))}
      </div>
    </div>
  );
}

function ConflictPane({
  label,
  content,
  className,
}: {
  label: string;
  content: string;
  className?: string;
}): JSX.Element {
  return (
    <div className="min-w-0 overflow-hidden rounded border border-deck-border/50 bg-[#0f1218]">
      <div className="border-b border-deck-border/50 px-2 py-1 text-[10px] font-medium text-deck-muted/90">
        {label}
      </div>
      <pre
        className={`m-0 max-h-80 overflow-auto scrollbar-deck p-2 font-mono text-[10px] leading-5 text-deck-text ${className ?? ''}`}
      >
        {content}
      </pre>
    </div>
  );
}
