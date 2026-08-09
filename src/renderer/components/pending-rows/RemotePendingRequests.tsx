import { useState, type JSX } from 'react';

import {
  MCP_DIFF_PRESENTATION_SCHEMA,
  MCP_PLAN_PRESENTATION_SCHEMA,
  parseMcpPresentationDisplay,
} from '@contracts/index';

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
import type {
  RemotePendingPresentation,
  RemoteSessionSourceView,
} from '@renderer/remote-host/source-types';
import type {
  AgentEvent,
  DiffReviewRequest,
  DiffReviewResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
} from '@shared/types';
import { DiffReviewRow } from './DiffReviewRow';
import { ExitPlanRow } from './ExitPlanRow';

export function RemotePendingRequests({
  pending,
  sourceIdentity,
  agentId = 'remote',
  busy,
  onRespond,
  planReviewTransport,
}: {
  pending: RemoteHostPendingListDto;
  sourceIdentity: string;
  agentId?: string;
  busy: boolean;
  onRespond(
    presentation: RemotePendingPresentation,
    action: RemoteHostPendingAction,
    value?: RemoteHostJsonValue,
  ): Promise<void>;
  planReviewTransport?: RemoteSessionSourceView['planReviewTransport'];
}): JSX.Element {
  const requests = pending.requests;
  if (requests.length === 0) {
    return <div className="py-10 text-center text-[10px] text-deck-muted">没有待处理请求</div>;
  }
  return (
    <ol className="flex flex-col gap-2">
      {requests.map((request) => {
        const presentation = remotePendingPresentation(sourceIdentity, pending.revision, request);
        const mcp = remoteMcpPresentationRow(
          presentation, agentId, busy, onRespond, planReviewTransport,
        );
        if (mcp) return mcp;
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

function presentationEvent(
  presentation: RemotePendingPresentation,
  agentId: string,
  payload: ExitPlanModeRequest | DiffReviewRequest,
): AgentEvent {
  return {
    sessionId: presentation.request.sessionId,
    agentId,
    kind: 'waiting-for-user',
    payload,
    ts: presentation.request.createdAt,
    source: 'sdk',
  };
}

function remoteMcpPresentationRow(
  presentation: RemotePendingPresentation,
  agentId: string,
  busy: boolean,
  onRespond: Parameters<typeof RemotePendingRequests>[0]['onRespond'],
  planReviewTransport: RemoteSessionSourceView['planReviewTransport'] | undefined,
): JSX.Element | null {
  let display: ReturnType<typeof parseMcpPresentationDisplay>;
  try { display = parseMcpPresentationDisplay(presentation.request.display); }
  catch { return null; }
  if (!display) return null;
  const common = {
    sessionId: presentation.request.sessionId,
    agentId,
    isSdk: true,
    stillPending: presentation.request.status === 'pending',
    wasCancelled: presentation.request.status === 'cancelled',
    onResolved: () => undefined,
  };
  if (display.schema === MCP_PLAN_PRESENTATION_SCHEMA) {
    const payload: ExitPlanModeRequest = {
      type: 'exit-plan-mode',
      requestId: presentation.request.id,
      reviewSource: 'mcp',
      plan: display.plan,
      ...(display.title === undefined ? {} : { title: display.title }),
    };
    const respond = async (response: ExitPlanModeResponse): Promise<void> => {
      if (busy) throw new Error('另一项远程操作仍在进行，请稍后重试。');
      if (response.decision === 'approve') {
        await onRespond(presentation, 'accept');
        return;
      }
      if (response.decision !== 'keep-planning') {
        throw new Error('远程计划展示不支持切换本地权限模式。');
      }
      await onRespond(
        presentation,
        'reject',
        response.feedback?.trim() ? { feedback: response.feedback.trim() } : undefined,
      );
    };
    const reviewTransport = agentId === 'grok-build'
      ? null
      : planReviewTransport?.(presentation, agentId) ?? null;
    const unavailable = agentId === 'grok-build'
      ? 'Grok 当前不支持隔离的原生 fork；不会回退使用 Local 会话。'
      : '此远程 Core 未提供隔离计划审阅能力；不会回退使用 Local 会话。';
    return <ExitPlanRow
      key={`plan-${presentation.sourceIdentity}-${presentation.request.id}-${presentation.revision}-${presentation.digest}`}
      {...common}
      event={presentationEvent(presentation, agentId, payload)}
      payload={payload}
      respondOverride={respond}
      responseDisabled={busy}
      deepReviewTransport={reviewTransport ?? undefined}
      deepReviewDraftKey={`${presentation.sourceIdentity}\u0000${presentation.request.sessionId}\u0000${presentation.request.id}`}
      deepReviewUnavailableReason={reviewTransport ? undefined : unavailable}
    />;
  }
  if (display.schema === MCP_DIFF_PRESENTATION_SCHEMA) {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: presentation.request.id,
      mode: display.mode,
      rationale: display.rationale,
      ...(display.title === undefined ? {} : { title: display.title }),
      ...(display.filePath === undefined ? {} : { filePath: display.filePath }),
      ...(display.language === undefined ? {} : { language: display.language }),
      ...(display.instructions === undefined ? {} : { instructions: display.instructions }),
      ...(display.annotations === undefined ? {} : { annotations: display.annotations }),
      ...(display.pr === undefined ? {} : { pr: display.pr }),
      ...(display.conflict === undefined ? {} : { conflict: display.conflict }),
    };
    const respond = async (response: DiffReviewResponse): Promise<void> => {
      if (busy) throw new Error('另一项远程操作仍在进行，请稍后重试。');
      await onRespond(
        presentation,
        response.decision === 'approve' ? 'accept' : 'reject',
        response.decision === 'revise' && response.feedback?.trim()
          ? { feedback: response.feedback.trim() }
          : undefined,
      );
    };
    return <DiffReviewRow
      key={`diff-${presentation.sourceIdentity}-${presentation.request.id}-${presentation.revision}-${presentation.digest}`}
      {...common}
      event={presentationEvent(presentation, agentId, payload)}
      payload={payload}
      respondOverride={respond}
      responseDisabled={busy}
    />;
  }
  return null;
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
