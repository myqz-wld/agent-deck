import { useState, type JSX } from 'react';

import type {
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
} from '@shared/remote-host';
import { remoteHostQuestionIds } from '@shared/remote-host';
import { pendingActionSurface } from '@renderer/remote-host/remote-pending-presentation';
import type { RemotePendingPresentation } from '@renderer/remote-host/source-types';

const UTF8 = new TextEncoder();
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

function text(value: RemoteHostJsonValue | undefined, maximumBytes = 4_096): string | null {
  return typeof value === 'string' && value.trim() && !CONTROL.test(value) &&
    UTF8.encode(value).byteLength <= maximumBytes
    ? value
    : null;
}

/** Bounded compatibility row for older or malformed hosts that lack structured displays. */
export function RemotePendingFallbackRow({
  presentation,
  busy,
  onRespond,
}: {
  presentation: RemotePendingPresentation;
  busy: boolean;
  onRespond(
    presentation: RemotePendingPresentation,
    action: RemoteHostPendingAction,
    value?: RemoteHostJsonValue,
  ): Promise<void>;
}): JSX.Element {
  const request = presentation.request;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const questionIds = remoteHostQuestionIds(request.display);
  const labels: Record<RemoteHostPendingAction, string> = {
    accept: '批准并继续', approve: '允许本次', deny: '拒绝', reject: '继续调整', submit: '提交回答',
  };
  const actions = pendingActionSurface(request.kind);
  const pending = request.status === 'pending';
  const answersReady = questionIds.every((id) => Boolean(answers[id]?.trim()));
  const value = (): RemoteHostJsonObject => Object.fromEntries(
    questionIds.map((id) => [id, answers[id]?.trim() ?? '']),
  );
  const respond = async (action: RemoteHostPendingAction): Promise<void> => {
    setError(null);
    try {
      await onRespond(presentation, action, action === 'submit' ? value() : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const settled = !pending;
  const statusText = pending
    ? request.kind === 'ask-user-question'
      ? '❓ 收到问题'
      : request.kind === 'exit-plan'
        ? '📋 等待计划确认'
        : '等待处理'
    : request.status === 'cancelled'
      ? '🚫 已取消'
      : '✅ 已响应';
  return (
    <li
      data-testid={`remote-pending-${request.id}`}
      className={`min-w-0 rounded-md border p-2 text-[11px] ${
        settled
          ? 'border-deck-border/50 bg-white/[0.02] opacity-60'
          : request.kind === 'ask-user-question'
            ? 'border-status-working/40 bg-status-working/10'
            : 'border-status-waiting/40 bg-status-waiting/10'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
        <span className={pending ? 'text-status-waiting' : 'text-deck-muted'}>{statusText}</span>
        <span className="font-mono tabular-nums text-deck-muted/60">
          {new Date(request.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
        </span>
      </div>
      {request.kind === 'exit-plan' && (
        <div className="mt-1 space-y-1">
          {text(request.display.title) && (
            <div className="font-medium text-deck-text">{text(request.display.title)}</div>
          )}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/15 p-1.5 text-[10px] text-deck-text/85">
            {text(request.display.summary) ?? '计划内容不可用'}
          </pre>
        </div>
      )}
      {request.kind === 'ask-user-question' && (
        <div className="mt-2 space-y-1">
          {questionIds.map((questionId) => (
            <label key={questionId} className="block">
              <span className="text-deck-muted">{questionId}</span>
              <textarea
                aria-label={`回答：${questionId}`}
                value={answers[questionId] ?? ''}
                onChange={(event) => setAnswers((current) => ({
                  ...current,
                  [questionId]: event.target.value,
                }))}
                disabled={busy || !pending}
                maxLength={1_000}
                rows={2}
                placeholder="请输入回答"
                className="mt-0.5 w-full resize-y rounded border border-white/10 bg-black/20 px-1.5 py-1 disabled:opacity-40"
              />
            </label>
          ))}
        </div>
      )}
      {request.kind === 'diff-review' && (
        <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-deck-muted">
          {JSON.stringify(request.display, null, 2)}
        </pre>
      )}
      <div className="mt-2 flex justify-end gap-1">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy || !pending || (action === 'submit' && !answersReady)}
            onClick={() => void respond(action)}
            className={`rounded px-2 py-1 disabled:opacity-30 ${
              action === 'deny' || action === 'reject'
                ? 'bg-status-waiting/25 text-status-waiting hover:bg-status-waiting/35'
                : 'bg-status-working/25 text-status-working hover:bg-status-working/35'
            }`}
          >
            {labels[action]}
          </button>
        ))}
      </div>
      {error && <div role="alert" className="mt-2 text-[9px] text-red-200">{error}</div>}
    </li>
  );
}
