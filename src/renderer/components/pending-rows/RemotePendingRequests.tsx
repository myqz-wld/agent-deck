import type { JSX } from 'react';

import {
  MCP_DIFF_PRESENTATION_SCHEMA,
  MCP_PLAN_PRESENTATION_SCHEMA,
  parseMcpPresentationDisplay,
  parsePermissionPreviewDisplay,
} from '@contracts/index';

import type {
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingListDto,
} from '@shared/remote-host';
import {
  parseRemoteHostAskQuestionDisplay,
  parseRemoteHostNativeExitPlanDisplay,
} from '@shared/remote-host';
import {
  remotePendingPresentation,
} from '@renderer/remote-host/remote-pending-presentation';
import type {
  RemotePendingPresentation,
  RemoteSessionSourceView,
} from '@renderer/remote-host/source-types';
import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  DiffReviewRequest,
  DiffReviewResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
} from '@shared/types';
import { AskRow } from './AskRow';
import { DiffReviewRow } from './DiffReviewRow';
import { ExitPlanRow } from './ExitPlanRow';
import { PermissionRow } from './PermissionRow';

const UTF8 = new TextEncoder();
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

function text(value: RemoteHostJsonValue | undefined, maximumBytes = 4_096): string | null {
  return typeof value === 'string' && value.trim() && !CONTROL.test(value) &&
    UTF8.encode(value).byteLength <= maximumBytes
    ? value
    : null;
}

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
  planReviewTransport: RemoteSessionSourceView['planReviewTransport'];
}): JSX.Element {
  const requests = pending.requests;
  if (requests.length === 0) {
    return <div className="py-10 text-center text-[10px] text-deck-muted">没有待处理请求</div>;
  }
  return (
    <ol className="flex flex-col gap-2">
      {requests.map((request) => (
        <RemotePendingRequestRow
          key={`${request.id}\u0000${pending.revision}\u0000${sourceIdentity}`}
          request={request}
          revision={pending.revision}
          sourceIdentity={sourceIdentity}
          agentId={agentId}
          busy={busy}
          onRespond={onRespond}
          planReviewTransport={planReviewTransport}
        />
      ))}
    </ol>
  );
}

/** The shared pending row is also injected into a session's activity timeline. */
export function RemotePendingRequestRow({
  request,
  revision,
  sourceIdentity,
  agentId = 'remote',
  busy,
  onRespond,
  planReviewTransport,
}: {
  request: RemoteHostPendingListDto['requests'][number];
  revision: number;
  sourceIdentity: string;
  agentId?: string;
  busy: boolean;
  onRespond: Parameters<typeof RemotePendingRequests>[0]['onRespond'];
  planReviewTransport: RemoteSessionSourceView['planReviewTransport'];
}): JSX.Element | null {
  const presentation = remotePendingPresentation(sourceIdentity, revision, request);
  return remoteMcpPresentationRow(
    presentation, agentId, busy, onRespond, planReviewTransport,
  ) ?? remoteProviderPresentationRow(
    presentation, agentId, busy, onRespond,
  );
}

function presentationEvent(
  presentation: RemotePendingPresentation,
  agentId: string,
  payload: AskUserQuestionRequest | DiffReviewRequest | ExitPlanModeRequest | PermissionRequest,
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
  planReviewTransport: RemoteSessionSourceView['planReviewTransport'],
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
      : planReviewTransport(presentation, agentId);
    const unavailable = agentId === 'grok-build'
      ? 'Grok 当前暂不支持独立计划审阅。'
      : '当前远端版本暂不支持独立计划审阅。';
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

function remoteProviderPresentationRow(
  presentation: RemotePendingPresentation,
  agentId: string,
  busy: boolean,
  onRespond: Parameters<typeof RemotePendingRequests>[0]['onRespond'],
): JSX.Element | null {
  const request = presentation.request;
  const common = {
    sessionId: request.sessionId,
    agentId,
    isSdk: true,
    stillPending: request.status === 'pending',
    wasCancelled: request.status === 'cancelled',
    onResolved: () => undefined,
  };
  const key = `${presentation.sourceIdentity}-${request.id}-${presentation.revision}-${presentation.digest}`;
  if (request.kind === 'permission') {
    let preview: ReturnType<typeof parsePermissionPreviewDisplay>;
    try { preview = parsePermissionPreviewDisplay(request.display); }
    catch { return null; }
    if (!preview) return null;
    const approvalDisabledReason = preview.complete
      ? null
      : '授权输入未能完整安全展示；仅可拒绝此请求。';
    const payload: PermissionRequest = {
      type: 'permission-request',
      requestId: request.id,
      toolName: preview.tool,
      toolInput: preview.input,
    };
    return <PermissionRow
      key={`permission-${key}`}
      {...common}
      event={presentationEvent(presentation, agentId, payload)}
      payload={payload}
      respondOverride={(decision) => onRespond(
        presentation,
        decision === 'allow' ? 'approve' : 'deny',
      )}
      responseDisabled={busy}
      approvalDisabledReason={approvalDisabledReason}
    />;
  }
  if (request.kind === 'exit-plan') {
    const display = parseRemoteHostNativeExitPlanDisplay(request.display);
    if (!display) return null;
    const plan = text(display.summary);
    if (!plan) return null;
    const title = text(display.title, 512);
    const payload: ExitPlanModeRequest = {
      type: 'exit-plan-mode',
      requestId: request.id,
      plan,
      ...(title === null ? {} : { title }),
    };
    const respond = async (response: ExitPlanModeResponse): Promise<void> => {
      if (busy) throw new Error('另一项远程操作仍在进行，请稍后重试。');
      if (response.decision === 'approve') {
        await onRespond(presentation, 'accept', { targetMode: response.targetMode });
        return;
      }
      if (response.decision === 'approve-bypass') {
        await onRespond(presentation, 'accept', { targetMode: 'bypassPermissions' });
        return;
      }
      await onRespond(
        presentation,
        'reject',
        response.feedback?.trim() ? { feedback: response.feedback.trim() } : undefined,
      );
    };
    return <ExitPlanRow
      key={`provider-plan-${key}`}
      {...common}
      event={presentationEvent(presentation, agentId, payload)}
      payload={payload}
      respondOverride={respond}
      responseDisabled={busy}
    />;
  }
  if (request.kind !== 'ask-user-question') return null;
  const display = parseRemoteHostAskQuestionDisplay(request.display);
  if (!display) return null;
  const { questionIds, questions } = display;
  const payload: AskUserQuestionRequest = {
    type: 'ask-user-question',
    requestId: request.id,
    questions: questions.map((question) => ({
      question: question.question,
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description === null ? {} : { description: option.description }),
      })),
      ...(question.header === null ? {} : { header: question.header }),
    })),
  };
  const respond = async (answer: AskUserQuestionAnswer): Promise<void> => {
    if (answer.answers.length !== questionIds.length) {
      throw new Error('远程问题展示已变化，请刷新后重试。');
    }
    const value: RemoteHostJsonObject = Object.fromEntries(
      questionIds.map((id, index) => {
        const item = answer.answers[index]!;
        const other = item.other?.length ? item.other : undefined;
        const note = item.note?.length ? item.note : undefined;
        if (note === undefined && item.selected.length > 0 && other === undefined) {
          return [id, [...item.selected]];
        }
        if (note === undefined && item.selected.length === 0 && other !== undefined) {
          return [id, other];
        }
        return [id, {
          selected: [...item.selected],
          ...(other === undefined ? {} : { other }),
          ...(note === undefined ? {} : { note }),
        }];
      }),
    );
    await onRespond(presentation, 'submit', value);
  };
  return <AskRow
    key={`ask-${key}`}
    {...common}
    event={presentationEvent(presentation, agentId, payload)}
    payload={payload}
    respondOverride={respond}
    responseDisabled={busy}
  />;
}
