import { isJsonValue, type JsonValue } from '@contracts/index';
import { FeishuGatewayError } from './errors';
import { CONTROL_DATA_CHARACTERS, FORBIDDEN_TEXT_CHARACTERS } from './text-policy';
import type {
  EnrolledFeishuCredential,
  FeishuCardActionEvent,
  FeishuInboundEvent,
  FeishuMessageEvent,
  FeishuPendingAction,
} from './types';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;
const BASE_FIELDS = [
  'appId',
  'chatId',
  'chatType',
  'displayName',
  'eventId',
  'kind',
  'occurredAt',
  'openId',
  'schemaVersion',
  'tenantKey',
] as const;

export function isActiveCredentialForEvent(
  credential: EnrolledFeishuCredential,
  event: FeishuInboundEvent,
): boolean {
  return (
      credential.status === 'active' &&
      credential.authority === 'owner-equivalent' &&
      credential.appId === event.appId &&
      credential.tenantKey === event.tenantKey &&
      credential.openId === event.openId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(
  object: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allow.has(key)) throw new FeishuGatewayError('unknown_field', `${label}.${key} is unknown`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new FeishuGatewayError('invalid_event', `${label}.${key} is required`);
    }
  }
}

export function boundedUtf8(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new FeishuGatewayError('invalid_event', `${field} must be a bounded non-empty string`);
  }
  return value;
}

export function stableToken(value: unknown, field: string, maximumBytes = 256): string {
  const text = boundedUtf8(value, field, maximumBytes);
  if (!TOKEN.test(text)) {
    throw new FeishuGatewayError('invalid_event', `${field} must use stable token syntax`);
  }
  return text;
}

function validateBase(object: Record<string, unknown>): void {
  if (object.schemaVersion !== 1) {
    throw new FeishuGatewayError('invalid_event', 'Unsupported Feishu event schemaVersion');
  }
  stableToken(object.appId, 'appId');
  stableToken(object.tenantKey, 'tenantKey');
  stableToken(object.openId, 'openId');
  stableToken(object.chatId, 'chatId');
  if (!['group', 'p2p'].includes(String(object.chatType))) {
    throw new FeishuGatewayError('invalid_event', 'chatType is unsupported');
  }
  stableToken(object.eventId, 'eventId');
  if (!Number.isSafeInteger(object.occurredAt) || (object.occurredAt as number) < 0) {
    throw new FeishuGatewayError('invalid_event', 'occurredAt must be a non-negative integer');
  }
  if (object.displayName !== undefined) {
    const name = boundedUtf8(object.displayName, 'displayName', 256);
    if (CONTROL_DATA_CHARACTERS.test(name)) {
      throw new FeishuGatewayError('invalid_event', 'displayName contains control characters');
    }
  }
}

function validateAction(value: unknown): FeishuPendingAction {
  if (!isRecord(value)) throw new FeishuGatewayError('invalid_event', 'action must be an object');
  exactFields(
    value,
    [
      'action',
      'chatId',
      'chatType',
      'credentialId',
      'instanceId',
      'name',
      'nonce',
      'requestId',
      'revision',
      'contentDigest',
      'sessionId',
      'value',
    ],
    [
      'action',
      'chatId',
      'chatType',
      'credentialId',
      'instanceId',
      'name',
      'nonce',
      'requestId',
      'revision',
      'contentDigest',
      'sessionId',
    ],
    'action',
  );
  if (value.name !== 'pending.respond') {
    throw new FeishuGatewayError('unknown_command', 'Unknown Feishu card action');
  }
  const action = stableToken(value.action, 'action.action', 32);
  if (!['accept', 'approve', 'deny', 'reject', 'submit'].includes(action)) {
    throw new FeishuGatewayError('unknown_command', `Unknown pending action: ${action}`);
  }
  if (!['group', 'p2p'].includes(String(value.chatType))) {
    throw new FeishuGatewayError('invalid_event', 'action.chatType is unsupported');
  }
  if (value.value !== undefined && !isJsonValue(value.value)) {
    throw new FeishuGatewayError('invalid_event', 'action.value must be JSON-safe');
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new FeishuGatewayError('invalid_event', 'action.revision must be non-negative');
  }
  return {
    name: 'pending.respond',
    action: action as FeishuPendingAction['action'],
    instanceId: stableToken(value.instanceId, 'action.instanceId'),
    credentialId: stableToken(value.credentialId, 'action.credentialId'),
    chatId: stableToken(value.chatId, 'action.chatId'),
    chatType: value.chatType as FeishuPendingAction['chatType'],
    sessionId: stableToken(value.sessionId, 'action.sessionId'),
    requestId: stableToken(value.requestId, 'action.requestId'),
    revision: value.revision as number,
    contentDigest: stableToken(value.contentDigest, 'action.contentDigest', 128),
    nonce: stableToken(value.nonce, 'action.nonce', 512),
    ...(value.value === undefined ? {} : { value: value.value as JsonValue }),
  };
}

export function parseFeishuInboundEvent(value: unknown, maximumBytes = 32_768): FeishuInboundEvent {
  if (!isRecord(value)) throw new FeishuGatewayError('invalid_event', 'Event must be an object');
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new FeishuGatewayError('invalid_event', 'Event must be JSON serializable');
  }
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) {
    throw new FeishuGatewayError('input_too_large', 'Feishu event exceeds the configured limit');
  }
  if (value.kind === 'message') {
    exactFields(value, [...BASE_FIELDS, 'text'], [...BASE_FIELDS.filter((f) => f !== 'displayName'), 'text'], 'event');
    validateBase(value);
    return { ...(value as unknown as FeishuMessageEvent), text: boundedUtf8(value.text, 'text', maximumBytes) };
  }
  if (value.kind === 'card-action') {
    exactFields(value, [...BASE_FIELDS, 'action'], [...BASE_FIELDS.filter((f) => f !== 'displayName'), 'action'], 'event');
    validateBase(value);
    const action = validateAction(value.action);
    if (action.chatType !== value.chatType) {
      throw new FeishuGatewayError('invalid_event', 'Card chat type does not match its action');
    }
    return { ...(value as unknown as FeishuCardActionEvent), action };
  }
  throw new FeishuGatewayError('unknown_command', 'Unknown Feishu event kind');
}

export function requireBoundedText(text: string, maximumBytes: number): string {
  const bounded = boundedUtf8(text, 'text', maximumBytes);
  if (FORBIDDEN_TEXT_CHARACTERS.test(bounded)) {
    throw new FeishuGatewayError('invalid_command', 'Message contains forbidden control characters');
  }
  return bounded;
}
