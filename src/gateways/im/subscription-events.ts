import { isJsonObject, type AgentDeckEventEnvelope } from '@contracts/index';
import { FeishuGatewayError } from './errors';
import type { EnrolledFeishuCredential, NotificationEvent } from './types';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;

function boundedToken(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    !TOKEN.test(value)
  ) {
    throw new FeishuGatewayError(
      'invalid_core_event',
      `${field} is not a bounded Core event identifier`,
    );
  }
  return value;
}

export function validateCoreNotificationEvent(
  event: AgentDeckEventEnvelope,
  credential: EnrolledFeishuCredential,
  lastObservedRevision: number,
): NotificationEvent {
  if (event.instanceId !== credential.instanceId) {
    throw new FeishuGatewayError('invalid_core_event', 'Core event instance does not match');
  }
  if (
    !Number.isSafeInteger(event.revision) ||
    event.revision < 0 ||
    event.revision <= lastObservedRevision
  ) {
    throw new FeishuGatewayError(
      'invalid_core_event',
      'Core event revision is malformed, stale, or non-monotonic',
    );
  }
  const kind = boundedToken(event.kind, 'event.kind', 128);
  const entityId = event.entityId === null
    ? null
    : boundedToken(event.entityId, 'event.entityId', 256);
  let persisted: NotificationEvent['persisted'];
  if (kind === 'event.persisted' && isJsonObject(event.payload) &&
    typeof event.payload.kind === 'string' &&
    ['message', 'waiting-for-user'].includes(event.payload.kind)) {
    const id = event.payload.eventId;
    if (!entityId || !Number.isSafeInteger(id) || Number(id) < 1) {
      throw new FeishuGatewayError('invalid_core_event', 'Persisted message identity is invalid');
    }
    persisted = { eventId: Number(id), kind: event.payload.kind as 'message' | 'waiting-for-user' };
  }
  return {
    instanceId: credential.instanceId,
    revision: event.revision,
    kind,
    entityId,
    ...(persisted ? { persisted } : {}),
  };
}
