import { assertFeishuMethod } from './client-pool';
import type { FeishuCallbackAttempt } from './callback-attempt';
import { validatePendingListResult, validatePendingRespondResult } from './core-output';
import { classifyGatewayError, FeishuGatewayError } from './errors';
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
    chatType: action.chatType,
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await connected.client.request(
      'pending.list',
      { sessionId: action.sessionId },
      { deadlineMs: callback.remainingMs() },
    );
    const currentResult = validatePendingListResult(current, action.sessionId, limits);
    const revision = currentResult.revision;
    const pending = currentResult.requests.find((request) => request.id === action.requestId);
    if (!pending || pending.status !== 'pending') {
      // Repair a stale card without repeating the provider decision or inferring who approved it.
      return { text: '该请求已处理，无需再次操作。', revision, cards: [], errorCode: 'already_decided',
        presentation: { title: '审批已结束', standalone: true } };
    }
    if (
      revision < action.revision ||
      // The signed revision identifies this presentation, not the entire Core's current state.
      // Unrelated sessions, usage and metadata can advance Core while this request stays identical.
      pendingContentDigest(pending, action.revision, action.chatType) !== action.contentDigest
    ) {
      throw new FeishuGatewayError(
        'pending_context_changed',
        'Pending approval context changed after the card was issued',
      );
    }
    validatePendingActionSemantics(pending, action.action, action.value);
    assertFeishuMethod(connected.hello, 'pending.respond');
    await beforeMutation();
    let raw: unknown;
    try { raw = await connected.client.request(
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
    ); } catch (error) {
      // A Core CAS conflict precedes the provider decision. Re-read and revalidate exactly once,
      // using the same idempotency key; uncertain/deadline outcomes must never be blindly retried.
      if (attempt === 0 && classifyGatewayError(error).code === 'conflict') continue;
      throw error;
    }
    const result = validatePendingRespondResult(raw, limits);
    return {
      text: result.status === 'denied' ? '已拒绝这次请求。' : '已确认，助手将继续处理。',
      revision: result.revision,
      cards: [],
      presentation: { title: result.status === 'denied' ? '已拒绝' : action.action === 'approve' ? '已批准' : '已确认', standalone: true },
    };
  }
  throw new FeishuGatewayError('conflict', 'Approval changed during confirmation');
}
