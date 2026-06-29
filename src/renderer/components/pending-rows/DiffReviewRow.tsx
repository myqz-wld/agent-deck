import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import type { AgentEvent, DiffReviewRequest, DiffReviewResponse } from '@shared/types';
import {
  DiffIntroCards,
  DiffPresentationPanel,
  buildPrDiffPayload,
} from './diff-review-presentation';
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

      <DiffIntroCards rationale={payload.rationale} instructions={payload.instructions} />

      <DiffPresentationPanel payload={payload} diffPayload={diffPayload} sessionId={sessionId} />

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
