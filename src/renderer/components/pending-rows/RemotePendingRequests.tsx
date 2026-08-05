import { useState, type JSX } from 'react';

import type {
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingListDto,
} from '@shared/remote-host';
import { remoteHostQuestionIds } from '@shared/remote-host';
import {
  pendingActionSurface,
  remotePendingPresentation,
} from '@renderer/remote-host/remote-pending-presentation';
import type { RemotePendingPresentation } from '@renderer/remote-host/source-types';

export function RemotePendingRequests({
  pending,
  sourceIdentity,
  busy,
  onRespond,
}: {
  pending: RemoteHostPendingListDto;
  sourceIdentity: string;
  busy: boolean;
  onRespond(
    presentation: RemotePendingPresentation,
    action: RemoteHostPendingAction,
    value?: RemoteHostJsonValue,
  ): Promise<void>;
}): JSX.Element {
  const requests = pending.requests;
  if (requests.length === 0) {
    return <div className="py-10 text-center text-[10px] text-deck-muted">没有待处理请求</div>;
  }
  return (
    <ol className="flex flex-col gap-2">
      {requests.map((request) => {
        const presentation = remotePendingPresentation(sourceIdentity, pending.revision, request);
        return <RemotePendingRequest
          key={`${request.id}\u0000${presentation.revision}\u0000${presentation.digest}\u0000${sourceIdentity}`}
          presentation={presentation}
          busy={busy}
          onRespond={onRespond}
        />;
      })}
    </ol>
  );
}

function RemotePendingRequest({
  presentation,
  busy,
  onRespond,
}: {
  presentation: RemotePendingPresentation;
  busy: boolean;
  onRespond: Parameters<typeof RemotePendingRequests>[0]['onRespond'];
}): JSX.Element {
  const request = presentation.request;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const questionIds = remoteHostQuestionIds(request.display);
  const labels: Record<RemoteHostPendingAction, string> = {
    accept: '接受', approve: '批准', deny: '拒绝', reject: '拒绝', submit: '提交',
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
  return (
    <li
      data-testid={`remote-pending-${request.id}`}
      className="rounded border border-amber-400/20 bg-amber-500/5 p-2 text-[10px]"
    >
      <div className="flex justify-between gap-2 font-medium text-amber-100">
        <span>{request.kind}</span><span>{request.status}</span>
      </div>
      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-deck-muted">
        {JSON.stringify(request.display, null, 2)}
      </pre>
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
      <div className="mt-2 flex justify-end gap-1">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy || !pending || (action === 'submit' && !answersReady)}
            onClick={() => void respond(action)}
            className="rounded bg-white/8 px-2 py-1 hover:bg-white/12 disabled:opacity-30"
          >
            {labels[action]}
          </button>
        ))}
      </div>
      {error && <div role="alert" className="mt-2 text-[9px] text-red-200">{error}</div>}
    </li>
  );
}
