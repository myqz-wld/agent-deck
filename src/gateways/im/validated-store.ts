import { FeishuGatewayError } from './errors';
import type {
  DeliveryClaim,
  EnrolledFeishuCredential,
  FeishuChatContext,
  FeishuCursorRecord,
  FeishuDeliveryRecord,
  FeishuGatewayBinding,
  FeishuGatewayLimits,
  FeishuGatewayStore,
  FeishuSessionDeleteClaim,
  FeishuSessionDeleteConfirmation,
  FeishuStableSubject,
  FeishuSubscriptionRecord,
} from './types';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;
const DELIVERY_STATUSES = new Set(['deduplicated', 'exhausted', 'failed', 'pending', 'reconciling', 'sent']);
const PHASES = new Set(['core', 'pre-transport', 'transport-invoked']);

function fail(): never {
  throw new FeishuGatewayError('invalid_configuration', 'Persisted Feishu metadata is malformed');
}

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail();
}

function token(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    !TOKEN.test(value)
  ) fail();
  return value;
}

function integer(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) fail();
  return value as number;
}

function credential(value: unknown): EnrolledFeishuCredential {
  exact(value, [
    'appId', 'authority', 'connectionScope', 'credentialId', 'instanceId', 'openId', 'status',
    'tenantKey', 'topology',
  ]);
  if (
    !['active', 'revoked'].includes(String(value.status)) ||
    value.authority !== 'owner-equivalent' ||
    !['relay', 'full'].includes(String(value.topology))
  ) fail();
  return {
    appId: token(value.appId),
    tenantKey: token(value.tenantKey),
    openId: token(value.openId),
    instanceId: token(value.instanceId),
    credentialId: token(value.credentialId),
    connectionScope: token(value.connectionScope),
    topology: value.topology as EnrolledFeishuCredential['topology'],
    status: value.status as EnrolledFeishuCredential['status'],
    authority: 'owner-equivalent',
  };
}

function context(value: unknown): FeishuChatContext {
  exact(value, [
    'activeSessionId', 'chatId', 'chatType', 'credentialId', 'instanceId', 'openId', 'updatedAt',
  ]);
  if (value.activeSessionId !== null) token(value.activeSessionId);
  if (!['group', 'p2p'].includes(String(value.chatType))) fail();
  return {
    instanceId: token(value.instanceId), credentialId: token(value.credentialId),
    chatId: token(value.chatId), openId: token(value.openId),
    chatType: value.chatType as FeishuChatContext['chatType'],
    activeSessionId: value.activeSessionId as string | null, updatedAt: integer(value.updatedAt),
  };
}

function subscription(value: unknown): FeishuSubscriptionRecord {
  exact(value, ['chatId', 'credentialId', 'instanceId', 'sessionId', 'status', 'updatedAt']);
  if (!['active', 'inactive'].includes(String(value.status))) fail();
  return {
    instanceId: token(value.instanceId), credentialId: token(value.credentialId),
    chatId: token(value.chatId), sessionId: token(value.sessionId),
    status: value.status as FeishuSubscriptionRecord['status'], updatedAt: integer(value.updatedAt),
  };
}

function cursor(value: unknown): FeishuCursorRecord {
  exact(value, ['chatId', 'credentialId', 'instanceId', 'revision', 'updatedAt']);
  return {
    instanceId: token(value.instanceId), credentialId: token(value.credentialId),
    chatId: token(value.chatId), revision: integer(value.revision), updatedAt: integer(value.updatedAt),
  };
}

function delivery(value: unknown): FeishuDeliveryRecord {
  exact(value, [
    'attemptDeadlineAt', 'attempts', 'chatId', 'credentialId', 'eventId', 'instanceId',
    'phase', 'status', 'transportIdempotencyExpiresAt', 'transportSafety', 'updatedAt',
  ]);
  if (
    !DELIVERY_STATUSES.has(String(value.status)) ||
    !PHASES.has(String(value.phase)) ||
    ![null, 'safe', 'unknown'].includes(value.transportSafety as null | string)
  ) fail();
  const valid = {
    instanceId: token(value.instanceId), eventId: token(value.eventId),
    credentialId: token(value.credentialId), chatId: token(value.chatId),
    status: value.status as FeishuDeliveryRecord['status'], attempts: integer(value.attempts, true),
    phase: value.phase as FeishuDeliveryRecord['phase'],
    transportSafety: value.transportSafety as FeishuDeliveryRecord['transportSafety'],
    transportIdempotencyExpiresAt: value.transportIdempotencyExpiresAt === null
      ? null
      : integer(value.transportIdempotencyExpiresAt, true),
    attemptDeadlineAt: integer(value.attemptDeadlineAt), updatedAt: integer(value.updatedAt),
  };
  if ((valid.phase === 'transport-invoked') !== (valid.transportSafety !== null)) fail();
  if (
    (valid.transportSafety === 'safe') !== (valid.transportIdempotencyExpiresAt !== null)
  ) fail();
  if (
    valid.status === 'reconciling' &&
    (valid.phase !== 'transport-invoked' || valid.transportSafety !== 'unknown')
  ) fail();
  return valid;
}

function validClaimState(state: DeliveryClaim['state'], record: FeishuDeliveryRecord): boolean {
  if (state === 'claimed' || state === 'in-progress') return record.status === 'pending';
  if (state === 'duplicate') return record.status === 'deduplicated';
  if (state === 'exhausted') return record.status === 'exhausted';
  return record.status === 'reconciling';
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail();
  return value;
}

function deleteConfirmation(value: unknown): FeishuSessionDeleteConfirmation {
  exact(value, [
    'chatId', 'claimEventId', 'claimExpiresAt', 'confirmationId', 'createdAt', 'credentialId',
    'expectedArchived', 'expectedUpdatedAt', 'expiresAt', 'instanceId', 'openId', 'sessionId',
    'status', 'tokenHash', 'updatedAt',
  ]);
  if (
    !['completed', 'executing', 'expired', 'pending'].includes(String(value.status)) ||
    typeof value.expectedArchived !== 'boolean' ||
    typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.tokenHash)
  ) fail();
  const result = {
    instanceId: token(value.instanceId), confirmationId: token(value.confirmationId),
    tokenHash: value.tokenHash, credentialId: token(value.credentialId),
    chatId: token(value.chatId), openId: token(value.openId), sessionId: token(value.sessionId),
    expectedArchived: value.expectedArchived, expectedUpdatedAt: integer(value.expectedUpdatedAt),
    status: value.status as FeishuSessionDeleteConfirmation['status'],
    claimEventId: value.claimEventId === null ? null : token(value.claimEventId),
    claimExpiresAt: value.claimExpiresAt === null ? null : integer(value.claimExpiresAt),
    expiresAt: integer(value.expiresAt), createdAt: integer(value.createdAt),
    updatedAt: integer(value.updatedAt),
  };
  if (
    result.expiresAt <= result.createdAt || result.updatedAt < result.createdAt ||
    (result.status === 'executing') !==
      (result.claimEventId !== null && result.claimExpiresAt !== null) ||
    (result.status !== 'executing' && result.status !== 'completed' &&
      (result.claimEventId !== null || result.claimExpiresAt !== null)) ||
    (result.status === 'completed' &&
      (result.claimEventId === null || result.claimExpiresAt !== null))
  ) fail();
  return result;
}

function deleteClaim(value: unknown): FeishuSessionDeleteClaim {
  exact(value, ['record', 'state']);
  if (!['claimed', 'completed', 'expired', 'in-progress', 'invalid'].includes(String(value.state))) {
    fail();
  }
  const state = value.state as FeishuSessionDeleteClaim['state'];
  const record = value.record === null ? null : deleteConfirmation(value.record);
  if ((state === 'invalid') !== (record === null)) fail();
  if (
    (state === 'claimed' && record?.status !== 'executing') ||
    (state === 'completed' && record?.status !== 'completed') ||
    (state === 'expired' && record?.status !== 'expired') ||
    (state === 'in-progress' && record?.status !== 'executing')
  ) fail();
  return { state, record };
}

/** Treats every metadata-store read as untrusted and bounds persisted cardinality. */
export class ValidatedFeishuGatewayStore implements FeishuGatewayStore {
  constructor(
    private readonly raw: FeishuGatewayStore,
    private readonly binding: FeishuGatewayBinding,
    private readonly limits: FeishuGatewayLimits,
  ) {}

  resolveCredential(subject: FeishuStableSubject): EnrolledFeishuCredential | null {
    const value = this.raw.resolveCredential(subject);
    if (value === null) return null;
    const valid = credential(value);
    if (
      valid.appId !== subject.appId ||
      valid.tenantKey !== subject.tenantKey ||
      valid.openId !== subject.openId
    ) fail();
    return valid;
  }

  listActiveCredentials(): readonly EnrolledFeishuCredential[] {
    const values = this.raw.listActiveCredentials();
    if (!Array.isArray(values) || values.length > this.limits.maxActiveCredentials) fail();
    const valid = values.map(credential);
    if (valid.some((value) => value.status !== 'active')) fail();
    const subjects = new Set(valid.map((value) => `${value.appId}\u001f${value.tenantKey}\u001f${value.openId}`));
    const ids = new Set(valid.map((value) => `${value.instanceId}\u001f${value.credentialId}`));
    if (subjects.size !== valid.length || ids.size !== valid.length) fail();
    return valid;
  }

  getContext(instanceId: string, credentialId: string, chatId: string): FeishuChatContext | null {
    const value = this.raw.getContext(instanceId, credentialId, chatId);
    if (value === null) return null;
    const valid = context(value);
    if (
      valid.instanceId !== instanceId ||
      valid.credentialId !== credentialId ||
      valid.chatId !== chatId
    ) fail();
    return valid;
  }

  listContexts(): readonly FeishuChatContext[] {
    const values = this.raw.listContexts();
    if (!Array.isArray(values) || values.length > this.limits.maxPersistedContexts) fail();
    const valid = values.map(context);
    const keys = new Set(valid.map((value) => `${value.instanceId}\u001f${value.credentialId}\u001f${value.chatId}`));
    if (keys.size !== valid.length) fail();
    return valid;
  }

  putContext(value: FeishuChatContext): void {
    const valid = context(value);
    if (!this.getContext(valid.instanceId, valid.credentialId, valid.chatId)) {
      if (this.listContexts().length >= this.limits.maxPersistedContexts) fail();
    }
    this.raw.putContext(valid);
  }

  getSubscription(instanceId: string, credentialId: string, chatId: string, sessionId: string) {
    const value = this.raw.getSubscription(instanceId, credentialId, chatId, sessionId);
    if (value === null) return null;
    const valid = subscription(value);
    if (
      valid.instanceId !== instanceId || valid.credentialId !== credentialId ||
      valid.chatId !== chatId || valid.sessionId !== sessionId
    ) fail();
    return valid;
  }

  listSubscriptions(instanceId: string, credentialId: string, chatId: string) {
    const values = this.raw.listSubscriptions(instanceId, credentialId, chatId);
    if (!Array.isArray(values) || values.length > this.limits.maxSubscriptionsPerChat) fail();
    const valid = values.map(subscription);
    if (valid.some((value) =>
      value.instanceId !== instanceId ||
      value.credentialId !== credentialId ||
      value.chatId !== chatId
    )) fail();
    const ids = new Set(valid.map((value) => value.sessionId));
    if (ids.size !== valid.length) fail();
    return valid;
  }

  putSubscription(value: FeishuSubscriptionRecord): void {
    const valid = subscription(value);
    const existing = this.getSubscription(
      valid.instanceId,
      valid.credentialId,
      valid.chatId,
      valid.sessionId,
    );
    if (
      !existing &&
      this.listSubscriptions(valid.instanceId, valid.credentialId, valid.chatId).length >=
        this.limits.maxSubscriptionsPerChat
    ) fail();
    this.raw.putSubscription(valid);
  }

  claimDelivery(
    value: Omit<
      FeishuDeliveryRecord,
      'attemptDeadlineAt' | 'attempts' | 'phase' | 'status' |
      'transportIdempotencyExpiresAt' | 'transportSafety'
    >,
    maximumEventAttempts: number,
    attemptLifetimeMs?: number,
  ): DeliveryClaim {
    token(value.instanceId); token(value.eventId); token(value.credentialId); token(value.chatId);
    integer(value.updatedAt);
    const claim = this.raw.claimDelivery(value, maximumEventAttempts, attemptLifetimeMs);
    exact(claim, ['record', 'state']);
    if (!['claimed', 'duplicate', 'exhausted', 'in-progress', 'reconciliation-required'].includes(String(claim.state))) fail();
    const record = delivery(claim.record);
    if (
      record.instanceId !== value.instanceId || record.eventId !== value.eventId ||
      record.credentialId !== value.credentialId || record.chatId !== value.chatId
    ) fail();
    if (
      !validClaimState(claim.state as DeliveryClaim['state'], record) ||
      record.attempts > maximumEventAttempts ||
      (claim.state === 'claimed' &&
        (record.phase !== 'core' || record.attemptDeadlineAt <= value.updatedAt)) ||
      (claim.state === 'in-progress' && record.attemptDeadlineAt <= value.updatedAt)
    ) fail();
    return { state: claim.state as DeliveryClaim['state'], record };
  }

  markDeliveryPreTransport(instanceId: string, eventId: string, attempt: number, at: number) {
    return boolean(this.raw.markDeliveryPreTransport(instanceId, eventId, attempt, at));
  }
  markDeliveryTransportInvoked(
    instanceId: string,
    eventId: string,
    attempt: number,
    safety: 'safe' | 'unknown',
    expiresAt: number | null,
    at: number,
  ) {
    return boolean(this.raw.markDeliveryTransportInvoked(
      instanceId, eventId, attempt, safety, expiresAt, at,
    ));
  }
  markDeliveryNotAccepted(instanceId: string, eventId: string, attempt: number, at: number) {
    return boolean(this.raw.markDeliveryNotAccepted(instanceId, eventId, attempt, at));
  }
  finishDelivery(instanceId: string, eventId: string, attempt: number, status: 'failed' | 'reconciling' | 'sent', at: number) {
    return boolean(this.raw.finishDelivery(instanceId, eventId, attempt, status, at));
  }
  getDelivery(instanceId: string, eventId: string) {
    const value = this.raw.getDelivery(instanceId, eventId);
    if (value === null) return null;
    const valid = delivery(value);
    if (valid.instanceId !== instanceId || valid.eventId !== eventId) fail();
    return valid;
  }
  requireDeliveryReconciliation(instanceId: string, eventId: string, attempt: number, at: number) {
    return boolean(this.raw.requireDeliveryReconciliation(instanceId, eventId, attempt, at));
  }
  getCursor(instanceId: string, credentialId: string, chatId: string) {
    const value = this.raw.getCursor(instanceId, credentialId, chatId);
    if (value === null) return null;
    const valid = cursor(value);
    if (
      valid.instanceId !== instanceId ||
      valid.credentialId !== credentialId ||
      valid.chatId !== chatId
    ) fail();
    return valid;
  }
  putCursor(value: FeishuCursorRecord): void {
    const valid = cursor(value);
    if (valid.instanceId !== this.binding.instanceId) fail();
    this.raw.putCursor(valid);
  }
  createDeleteConfirmation(value: FeishuSessionDeleteConfirmation) {
    const valid = deleteConfirmation(value);
    if (valid.instanceId !== this.binding.instanceId || valid.status !== 'pending') fail();
    const stored = deleteConfirmation(this.raw.createDeleteConfirmation(valid));
    if (stored.confirmationId !== valid.confirmationId) fail();
    return stored;
  }
  claimDeleteConfirmation(input: Parameters<FeishuGatewayStore['claimDeleteConfirmation']>[0]) {
    token(input.instanceId); token(input.credentialId); token(input.chatId); token(input.openId);
    token(input.eventId); integer(input.now); integer(input.claimLifetimeMs, true);
    if (!/^[0-9a-f]{64}$/u.test(input.tokenHash) || input.instanceId !== this.binding.instanceId) fail();
    const claim = deleteClaim(this.raw.claimDeleteConfirmation(input));
    if (claim.record && (
      claim.record.instanceId !== input.instanceId ||
      claim.record.credentialId !== input.credentialId ||
      claim.record.chatId !== input.chatId || claim.record.openId !== input.openId
    )) fail();
    return claim;
  }
  releaseDeleteConfirmation(i: string, c: string, e: string, at: number) {
    token(i); token(c); token(e); integer(at);
    return boolean(this.raw.releaseDeleteConfirmation(i, c, e, at));
  }
  completeDeleteConfirmation(i: string, c: string, e: string, at: number) {
    token(i); token(c); token(e); integer(at);
    return boolean(this.raw.completeDeleteConfirmation(i, c, e, at));
  }
  getDeleteConfirmation(i: string, c: string) {
    token(i); token(c);
    const value = this.raw.getDeleteConfirmation(i, c);
    if (value === null) return null;
    const valid = deleteConfirmation(value);
    if (valid.instanceId !== i || valid.confirmationId !== c) fail();
    return valid;
  }
  pruneDeleteConfirmations(before: number, now: number): number {
    integer(before); integer(now);
    return integer(this.raw.pruneDeleteConfirmations(before, now));
  }
  pruneDeliveries(terminalBefore: number): number {
    integer(terminalBefore);
    const removed = this.raw.pruneDeliveries(terminalBefore);
    return integer(removed);
  }
}
