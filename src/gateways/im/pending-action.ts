import { assertFeishuMethod } from './client-pool';
import type { FeishuCallbackAttempt } from './callback-attempt';
import { coreRevision, validatePendingRequests } from './core-output';
import { FeishuGatewayError } from './errors';
import { pendingContentDigest } from './pending-binding';
import { validatePendingActionSemantics } from './pending-semantics';
import type {
  ConnectedFeishuClient,
  EnrolledFeishuCredential,
  FeishuCardActionEvent,
  FeishuGatewayLimits,
  PendingActionNoncePort,
  SessionConsoleView,
} from './types';

export async function executePendingCardAction(
  event: FeishuCardActionEvent,
  credential: EnrolledFeishuCredential,
  connected: ConnectedFeishuClient,
  callback: FeishuCallbackAttempt,
  nonce: PendingActionNoncePort,
  limits: FeishuGatewayLimits,
  beforeMutation: () => Promise<void>,
): Promise<SessionConsoleView> {
  const action = event.action;
  if (
    action.instanceId !== credential.instanceId ||
    action.credentialId !== credential.credentialId ||
    action.chatId !== event.chatId
  ) {
    throw new FeishuGatewayError('access_denied', 'Card identity does not match this callback');
  }
  const binding = {
    instanceId: action.instanceId,
    credentialId: action.credentialId,
    chatId: action.chatId,
    sessionId: action.sessionId,
    requestId: action.requestId,
    revision: action.revision,
    contentDigest: action.contentDigest,
    action: action.action,
  };
  if (!nonce.verify(binding, action.nonce)) {
    throw new FeishuGatewayError('invalid_nonce', 'Card nonce is invalid');
  }
  assertFeishuMethod(connected.hello, 'pending.list');
  const current = await connected.client.request(
    'pending.list',
    { sessionId: action.sessionId },
    { deadlineMs: callback.remainingMs() },
  );
  const revision = coreRevision(current.revision);
  const requests = validatePendingRequests(current.requests, action.sessionId, limits);
  const pending = requests.find((request) => request.id === action.requestId);
  if (!pending || pending.status !== 'pending') {
    throw new FeishuGatewayError(
      'already_decided',
      '该请求已不是 pending 状态',
      false,
      revision,
    );
  }
  if (
    action.revision !== revision ||
    pendingContentDigest(pending, revision) !== action.contentDigest
  ) {
    throw new FeishuGatewayError(
      'pending_context_changed',
      'Pending approval context changed after the card was issued',
    );
  }
  validatePendingActionSemantics(pending, action.action, action.value);
  assertFeishuMethod(connected.hello, 'pending.respond');
  await beforeMutation();
  const result = await connected.client.request(
    'pending.respond',
    {
      sessionId: action.sessionId,
      requestId: action.requestId,
      action: action.action,
      ...(action.value === undefined ? {} : { value: action.value }),
    },
    {
      idempotencyKey: `feishu:${event.eventId}`,
      expectedRevision: revision,
      deadlineMs: callback.remainingMs(),
    },
  );
  if (!['cancelled', 'denied', 'expired', 'resolved', 'stale'].includes(result.status)) {
    throw new FeishuGatewayError('invalid_core_response', 'Pending response status is malformed');
  }
  return {
    text: `请求已更新为 ${result.status}`,
    revision: coreRevision(result.revision),
    cards: [],
  };
}
