import { isJsonValue, type JsonObject, type JsonValue } from '@contracts/index';
import {
  FeishuGatewayError,
  parseFeishuInboundEvent,
  type FeishuPendingAction,
} from '@gateways/im';
import {
  FEISHU_ACTION_PROTOCOL,
  type FeishuCardActionEnvelope,
  type FeishuQuestionFieldBinding,
} from './action-envelope';
import type { MappedFeishuEvent } from './types';
import { CONTROL_DATA_CHARACTERS, FORBIDDEN_TEXT_CHARACTERS } from '@gateways/im/text-policy';

const UTF8 = new TextEncoder();
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;
const MAX_RAW_EVENT_BYTES = 64_000;

export interface FeishuEventMapperOptions {
  appId: string;
  tenantKey: string;
  now(): number;
  maximumRawBytes?: number;
  /** Authenticated app identity, resolved before SDK event delivery starts. */
  botOpenId?: string;
}

function fail(code: string, message: string): never {
  throw new FeishuGatewayError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_event', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) fail('unknown_field', `${label}.${key} is unknown`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('invalid_event', `${label}.${key} is required`);
    }
  }
}

function bounded(
  value: unknown, label: string, maximum = 512, controls = CONTROL_DATA_CHARACTERS,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    UTF8.encode(value).byteLength > maximum ||
    controls.test(value)
  ) fail('invalid_event', `${label} is malformed`);
  return value;
}

function token(value: unknown, label: string, maximum = 256): string {
  const text = bounded(value, label, maximum);
  if (!TOKEN.test(text)) fail('invalid_event', `${label} is malformed`);
  return text;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[0-9]{10,16}$/.test(value)) {
    return fail('invalid_event', `${label} is malformed`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('invalid_event', `${label} is malformed`);
  return parsed >= 100_000_000_000_000 ? Math.floor(parsed / 1_000) : parsed;
}

function assertRawBound(value: unknown, maximum: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail('invalid_event', 'Feishu SDK event is not JSON serializable');
  }
  if (UTF8.encode(serialized).byteLength > maximum) {
    fail('input_too_large', 'Feishu SDK event exceeds the configured limit');
  }
}

function commonHeader(
  raw: Record<string, unknown>,
  expectedType: 'card.action.trigger' | 'im.message.receive_v1',
  options: FeishuEventMapperOptions,
): { appId: string; tenantKey: string; eventId: string; occurredAt: number } {
  if (raw.schema !== '2.0' || raw.event_type !== expectedType) {
    fail('invalid_event', 'Unsupported Feishu callback schema or event type');
  }
  const appId = token(raw.app_id, 'event.app_id');
  const tenantKey = token(raw.tenant_key, 'event.tenant_key');
  if (appId !== options.appId || tenantKey !== options.tenantKey) {
    fail('access_denied', 'Feishu callback does not match the pinned app and tenant');
  }
  bounded(raw.token, 'event.token', 512);
  return {
    appId,
    tenantKey,
    eventId: token(raw.event_id, 'event.event_id'),
    occurredAt: timestamp(raw.create_time, 'event.create_time'),
  };
}

function validateMentions(value: unknown, options: FeishuEventMapperOptions): string[] {
  if (options.botOpenId !== undefined) token(options.botOpenId, 'bot.open_id');
  const addressedKeys: string[] = [];
  if (value === undefined) return addressedKeys;
  if (!Array.isArray(value) || value.length > 32) {
    fail('invalid_event', 'message.mentions is malformed');
  }
  for (const [index, item] of value.entries()) {
    const mention = record(item, `message.mentions[${index}]`);
    exact(mention, ['id', 'key', 'mentioned_type', 'name', 'tenant_key'], ['id', 'key'], `message.mentions[${index}]`);
    const key = bounded(mention.key, `message.mentions[${index}].key`, 128);
    if (mention.name !== undefined) bounded(mention.name, `message.mentions[${index}].name`, 256);
    const id = record(mention.id, `message.mentions[${index}].id`);
    exact(id, ['open_id', 'union_id', 'user_id'], [], `message.mentions[${index}].id`);
    if (!id.open_id && !id.union_id && !id.user_id) {
      fail('invalid_event', `message.mentions[${index}].id is empty`);
    }
    for (const field of ['open_id', 'union_id', 'user_id'] as const) {
      if (id[field] !== undefined) token(id[field], `message.mentions[${index}].id.${field}`);
    }
    if (mention.tenant_key !== undefined) token(mention.tenant_key, `message.mentions[${index}].tenant_key`);
    if (mention.mentioned_type !== undefined) bounded(mention.mentioned_type, `message.mentions[${index}].mentioned_type`, 32);
    if (/^@_user_[0-9]+$/.test(key) && id.open_id === options.botOpenId && options.botOpenId !== undefined &&
      (mention.tenant_key === undefined || mention.tenant_key === options.tenantKey)) {
      addressedKeys.push(key);
    }
  }
  // A duplicated placeholder is ambiguous even if one entry claims to be the bot.
  const keys = value.map((item) => (item as Record<string, unknown>).key);
  if (new Set(keys).size !== keys.length) fail('invalid_event', 'message mention keys are duplicated');
  return addressedKeys;
}

export function mapFeishuMessageEvent(
  value: unknown,
  options: FeishuEventMapperOptions,
): MappedFeishuEvent {
  assertRawBound(value, options.maximumRawBytes ?? MAX_RAW_EVENT_BYTES);
  const raw = record(value, 'event');
  exact(raw, [
    'app_id', 'create_time', 'event_id', 'event_type', 'message', 'schema', 'sender',
    'tenant_key', 'token',
  ], [
    'app_id', 'create_time', 'event_id', 'event_type', 'message', 'schema', 'sender',
    'tenant_key', 'token',
  ], 'event');
  const header = commonHeader(raw, 'im.message.receive_v1', options);
  const sender = record(raw.sender, 'sender');
  exact(sender, ['sender_id', 'sender_type', 'tenant_key'], ['sender_id', 'sender_type', 'tenant_key'], 'sender');
  if (sender.sender_type !== 'user' || token(sender.tenant_key, 'sender.tenant_key') !== header.tenantKey) {
    fail('access_denied', 'Feishu message sender is outside the pinned tenant');
  }
  const senderId = record(sender.sender_id, 'sender.sender_id');
  exact(senderId, ['open_id', 'union_id', 'user_id'], ['open_id'], 'sender.sender_id');
  const openId = token(senderId.open_id, 'sender.sender_id.open_id');
  for (const field of ['union_id', 'user_id'] as const) {
    if (senderId[field] !== undefined) token(senderId[field], `sender.sender_id.${field}`);
  }

  const message = record(raw.message, 'message');
  exact(message, [
    'chat_id', 'chat_type', 'content', 'create_time', 'lark_agent_context', 'mentions',
    'message_id', 'message_type', 'parent_id', 'root_id', 'thread_id', 'update_time',
    'user_agent',
  ], ['chat_id', 'chat_type', 'content', 'create_time', 'message_id', 'message_type'], 'message');
  if (!['group', 'p2p'].includes(String(message.chat_type)) || message.message_type !== 'text') {
    fail('unknown_command', 'Only Feishu text messages in p2p or group chats are supported');
  }
  timestamp(message.create_time, 'message.create_time');
  if (message.update_time !== undefined) timestamp(message.update_time, 'message.update_time');
  for (const field of ['parent_id', 'root_id', 'thread_id'] as const) {
    if (message[field] !== undefined) token(message[field], `message.${field}`);
  }
  if (message.user_agent !== undefined) bounded(message.user_agent, 'message.user_agent', 512);
  if (message.lark_agent_context !== undefined) {
    const context = record(message.lark_agent_context, 'message.lark_agent_context');
    exact(context, ['active_chat_id'], [], 'message.lark_agent_context');
    if (context.active_chat_id !== undefined) token(context.active_chat_id, 'message.lark_agent_context.active_chat_id');
  }
  const botMentions = validateMentions(message.mentions, options);
  const contentText = bounded(message.content, 'message.content', 32_768);
  let content: unknown;
  try {
    content = JSON.parse(contentText);
  } catch {
    return fail('invalid_event', 'Feishu text message content is not valid JSON');
  }
  const contentObject = record(content, 'message.content');
  exact(contentObject, ['text'], ['text'], 'message.content');
  const text = bounded(contentObject.text, 'message.content.text', 16_384, FORBIDDEN_TEXT_CHARACTERS);
  const addressed = text.trimStart();
  const prefix = message.chat_type === 'group' ? botMentions.find((key) =>
    addressed.startsWith(key) && /^[ \t\r\n]/.test(addressed.slice(key.length)),
  ) : undefined;
  const normalized = prefix ? addressed.slice(prefix.length).replace(/^[ \t\r\n]+/, '') : text;
  const chatId = token(message.chat_id, 'message.chat_id');
  const messageId = token(message.message_id, 'message.message_id');
  const event = parseFeishuInboundEvent({
    schemaVersion: 1,
    kind: 'message',
    ...header,
    openId,
    chatId,
    chatType: message.chat_type as 'group' | 'p2p',
    text: normalized,
  });
  return {
    event,
    source: { eventId: header.eventId, chatId, messageId, kind: 'message', occurredAt: header.occurredAt },
  };
}

function parseEnvelope(value: unknown, now: number): FeishuCardActionEnvelope {
  const envelope = record(value, 'action.value');
  exact(envelope, ['action', 'expiresAt', 'fields', 'protocol'], ['action', 'expiresAt', 'protocol'], 'action.value');
  if (envelope.protocol !== FEISHU_ACTION_PROTOCOL) fail('unknown_command', 'Unsupported Feishu card action protocol');
  if (
    envelope.expiresAt !== null &&
    (!Number.isSafeInteger(envelope.expiresAt) || (envelope.expiresAt as number) < 0)
  ) fail('invalid_event', 'action.value.expiresAt is malformed');
  if (envelope.expiresAt !== null && now > (envelope.expiresAt as number)) {
    fail('invalid_nonce', 'Feishu card presentation has expired');
  }
  const action = record(envelope.action, 'action.value.action');
  exact(action, [
    'action', 'chatId', 'chatType', 'contentDigest', 'credentialId', 'instanceId', 'name', 'nonce',
    'requestId', 'revision', 'sessionId',
  ], [
    'action', 'chatId', 'chatType', 'contentDigest', 'credentialId', 'instanceId', 'name', 'nonce',
    'requestId', 'revision', 'sessionId',
  ], 'action.value.action');
  const fields = envelope.fields === undefined ? undefined : parseFields(envelope.fields);
  return {
    protocol: FEISHU_ACTION_PROTOCOL,
    action: action as unknown as Omit<FeishuPendingAction, 'value'>,
    expiresAt: envelope.expiresAt as number | null,
    ...(fields ? { fields } : {}),
  };
}

function parseFields(value: unknown): readonly FeishuQuestionFieldBinding[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    return fail('invalid_event', 'action.value.fields is malformed');
  }
  const fields = value.map((item, index) => {
    const field = record(item, `action.value.fields[${index}]`);
    exact(field, ['providerKey', 'questionId'], ['providerKey', 'questionId'], `action.value.fields[${index}]`);
    return {
      providerKey: token(field.providerKey, `action.value.fields[${index}].providerKey`, 64),
      questionId: bounded(field.questionId, `action.value.fields[${index}].questionId`, 128),
    };
  });
  if (
    new Set(fields.map((item) => item.providerKey)).size !== fields.length ||
    new Set(fields.map((item) => item.questionId)).size !== fields.length
  ) fail('invalid_event', 'action.value.fields contains duplicates');
  return fields;
}

function mapFormValue(
  value: unknown,
  fields: readonly FeishuQuestionFieldBinding[],
): JsonObject {
  const form = record(value, 'action.form_value');
  const expected = [...fields.map((field) => field.providerKey)].sort();
  const actual = Object.keys(form).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid_event', 'action.form_value does not match the issued question fields');
  }
  const answers: JsonObject = {};
  for (const field of fields) {
    const answer = form[field.providerKey];
    if (!isJsonValue(answer)) fail('invalid_event', 'action.form_value is not JSON-safe');
    answers[field.questionId] = answer as JsonValue;
  }
  return answers;
}

export function mapFeishuCardActionEvent(
  value: unknown,
  options: FeishuEventMapperOptions,
): MappedFeishuEvent {
  assertRawBound(value, options.maximumRawBytes ?? MAX_RAW_EVENT_BYTES);
  const raw = record(value, 'event');
  exact(raw, [
    'action', 'app_id', 'context', 'create_time', 'event_id', 'event_type', 'host',
    'operator', 'schema', 'tenant_key', 'token',
  ], [
    'action', 'app_id', 'context', 'create_time', 'event_id', 'event_type', 'host',
    'operator', 'schema', 'tenant_key', 'token',
  ], 'event');
  const header = commonHeader(raw, 'card.action.trigger', options);
  if (raw.host !== 'im_message') fail('unknown_command', 'Unsupported Feishu card host');
  const operator = record(raw.operator, 'operator');
  exact(operator, ['name', 'open_id', 'tenant_key', 'union_id', 'user_id'], ['open_id', 'tenant_key'], 'operator');
  if (token(operator.tenant_key, 'operator.tenant_key') !== header.tenantKey) {
    fail('access_denied', 'Feishu card operator is outside the pinned tenant');
  }
  const openId = token(operator.open_id, 'operator.open_id');
  for (const field of ['union_id', 'user_id'] as const) {
    if (operator[field] !== undefined) token(operator[field], `operator.${field}`);
  }
  const displayName = operator.name === undefined ? undefined : bounded(operator.name, 'operator.name', 256);
  const context = record(raw.context, 'context');
  exact(context, ['open_chat_id', 'open_message_id'], ['open_chat_id', 'open_message_id'], 'context');
  const chatId = token(context.open_chat_id, 'context.open_chat_id');
  const messageId = token(context.open_message_id, 'context.open_message_id');
  const providerAction = record(raw.action, 'action');
  exact(providerAction, ['form_value', 'name', 'option', 'tag', 'timezone', 'value'], ['tag', 'value'], 'action');
  if (providerAction.tag !== 'button' || providerAction.option !== undefined) {
    fail('unknown_command', 'Only Feishu button callbacks are supported');
  }
  if (providerAction.name !== undefined) token(providerAction.name, 'action.name', 128);
  if (providerAction.timezone !== undefined) bounded(providerAction.timezone, 'action.timezone', 128);
  const envelope = parseEnvelope(providerAction.value, options.now());
  const isSubmit = envelope.action.action === 'submit';
  if (isSubmit !== Boolean(envelope.fields) || isSubmit !== (providerAction.form_value !== undefined)) {
    fail('invalid_event', 'Feishu form payload does not match the issued pending action');
  }
  const action = {
    ...envelope.action,
    ...(isSubmit
      ? { value: mapFormValue(providerAction.form_value, envelope.fields as readonly FeishuQuestionFieldBinding[]) }
      : {}),
  };
  const event = parseFeishuInboundEvent({
    schemaVersion: 1,
    kind: 'card-action',
    ...header,
    openId,
    chatId,
    chatType: envelope.action.chatType,
    ...(displayName === undefined ? {} : { displayName }),
    action,
  });
  return {
    event,
    source: { eventId: header.eventId, chatId, messageId, kind: 'card-action', occurredAt: header.occurredAt },
  };
}
