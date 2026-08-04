import type {
  JsonObject,
  PendingRequestDto,
  SessionHistoryEntryDto,
  SessionListItemDto,
  SessionRuntimeControlsDto,
} from '@contracts/index';
import { FeishuGatewayError } from './errors';
import { pendingContentDigest, pendingSecurityDisplay } from './pending-binding';
import { boundedJsonText, redactJson, truncateUtf8 } from './redaction';
import { stableToken } from './validation';
import type {
  EnrolledFeishuCredential,
  FeishuPendingCard,
  PendingActionNoncePort,
  SessionConsoleView,
} from './types';

export interface RenderContext {
  credential: EnrolledFeishuCredential;
  chatId: string;
  sessionId: string;
  nonce: PendingActionNoncePort;
  pendingPresentationLifetimeMs: number;
  maxOutputBytes: number;
  maxPendingCards: number;
}

function pendingTitle(request: PendingRequestDto): string {
  const labels: Record<PendingRequestDto['kind'], string> = {
    'ask-user-question': '等待回答',
    'diff-review': 'Diff review',
    'exit-plan': 'Plan approval',
    permission: 'Permission request',
  };
  return labels[request.kind];
}

function pendingCard(
  request: PendingRequestDto,
  context: RenderContext,
  revision: number,
): FeishuPendingCard {
  if (request.sessionId !== context.sessionId) {
    throw new FeishuGatewayError(
      'invalid_core_response',
      'Pending request belongs to a different session',
    );
  }
  const requestId = stableToken(request.id, 'pending.requestId');
  const sessionId = stableToken(request.sessionId, 'pending.sessionId');
  const binding = {
    instanceId: context.credential.instanceId,
    credentialId: context.credential.credentialId,
    chatId: context.chatId,
    sessionId,
    requestId,
    revision,
    contentDigest: pendingContentDigest(request, revision),
  };
  const actions = request.kind === 'permission'
    ? (['approve', 'deny'] as const)
    : request.kind === 'ask-user-question'
      ? (['submit'] as const)
      : (['accept', 'reject'] as const);
  const labels = {
    accept: '接受',
    approve: '批准',
    deny: '拒绝',
    reject: '拒绝',
    submit: '提交',
  } as const;
  const buttons = request.status === 'pending'
    ? actions.map((action) => ({
        label: labels[action],
        action: {
          name: 'pending.respond' as const,
          ...binding,
          action,
          nonce: stableToken(
            context.nonce.issue({ ...binding, action }),
            'pending.nonce',
            512,
          ),
        },
      }))
    : [];
  return {
    title: pendingTitle(request),
    requestId,
    sessionId,
    state: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    presentationLifetimeMs: context.pendingPresentationLifetimeMs,
    display: pendingSecurityDisplay(request),
    buttons,
  };
}

export function renderSessionList(
  sessions: readonly SessionListItemDto[],
  offset: number,
  total: number,
  maximumBytes: number,
  revision: number,
): SessionConsoleView {
  const lines = sessions.map(
    (session) =>
      `${session.id} · ${session.adapterId} · ${session.status} · ${session.title ?? '未命名'}`,
  );
  const next = offset + sessions.length < total ? `\n下一页：/sessions ${offset + sessions.length}` : '';
  return {
    text: truncateUtf8(`Sessions (${offset + 1}-${offset + sessions.length}/${total})\n${lines.join('\n')}${next}`, maximumBytes),
    sessions,
    revision,
  };
}

export function renderHistory(
  entries: readonly SessionHistoryEntryDto[],
  nextCursor: string | null,
  maximumBytes: number,
  revision: number,
): SessionConsoleView {
  const lines = entries.map(
    (entry) => `${entry.sequence} ${entry.role}: ${boundedJsonText(entry.content, 1_024)}`,
  );
  const next = nextCursor ? `\n下一页：/history ${nextCursor}` : '';
  return {
    text: truncateUtf8(`History\n${lines.join('\n')}${next}`, maximumBytes),
    history: entries.map((entry) => ({ ...entry, content: redactJson(entry.content) })),
    revision,
  };
}

export function renderPending(
  requests: readonly PendingRequestDto[],
  context: RenderContext,
  revision: number,
): SessionConsoleView {
  const bounded = requests.slice(0, context.maxPendingCards);
  const cards = bounded.map((request) => pendingCard(request, context, revision));
  const pendingCount = requests.filter((request) => request.status === 'pending').length;
  return {
    text: truncateUtf8(
      pendingCount === 0 ? '当前没有仍在 pending 的请求。' : `当前有 ${pendingCount} 个 pending 请求。`,
      context.maxOutputBytes,
    ),
    pending: bounded.map((request) => ({ ...request, display: redactJson(request.display) as JsonObject })),
    cards,
    revision,
  };
}

export function renderRuntime(
  controls: SessionRuntimeControlsDto,
  maximumBytes: number,
): SessionConsoleView {
  return {
    text: truncateUtf8(
      `${controls.adapterId} runtime controls (revision ${controls.revision})\n${boundedJsonText(controls.values, maximumBytes)}`,
      maximumBytes,
    ),
    revision: controls.revision,
  };
}
