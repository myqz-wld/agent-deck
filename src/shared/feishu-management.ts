import { isJsonObject, isJsonValue, type JsonValue } from '@contracts/index';

export const FEISHU_MANAGEMENT_SCHEMA_VERSION = 1;
export const FEISHU_MANAGEMENT_MAX_LINE_BYTES = 16_384;

export type FeishuManagementMethod =
  | 'pair.approve'
  | 'pair.code.create'
  | 'pair.list'
  | 'pair.reject'
  | 'status'
  | 'verify';

export interface FeishuManagementRequest {
  schemaVersion: 1;
  id: string;
  method: FeishuManagementMethod;
  params: Record<string, JsonValue>;
}

export type FeishuManagementResponse =
  | { schemaVersion: 1; id: string; ok: true; result: JsonValue }
  | {
      schemaVersion: 1;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

function fail(): never {
  throw new Error('Invalid Feishu management protocol value');
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail();
  }
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail();
  return value;
}

function params(value: unknown, method: FeishuManagementMethod): Record<string, JsonValue> {
  if (!isJsonObject(value)) fail();
  if (method === 'pair.approve' || method === 'pair.reject') {
    exact(value, ['requestId']);
    return { requestId: token(value.requestId) };
  }
  if (method === 'pair.list') {
    exact(value, ['status']);
    if (value.status !== 'all' && value.status !== 'pending') fail();
    return { status: value.status };
  }
  exact(value, []);
  return {};
}

export function parseFeishuManagementRequest(value: unknown): FeishuManagementRequest {
  if (!isJsonObject(value)) fail();
  exact(value, ['id', 'method', 'params', 'schemaVersion']);
  if (value.schemaVersion !== FEISHU_MANAGEMENT_SCHEMA_VERSION) fail();
  if (!['pair.approve', 'pair.code.create', 'pair.list', 'pair.reject', 'status', 'verify']
    .includes(String(value.method))) fail();
  const method = value.method as FeishuManagementMethod;
  return {
    schemaVersion: 1,
    id: token(value.id),
    method,
    params: params(value.params, method),
  };
}

export function parseFeishuManagementResponse(
  value: unknown,
  expectedId: string,
): FeishuManagementResponse {
  if (!isJsonObject(value) || typeof value.ok !== 'boolean') fail();
  exact(value, value.ok
    ? ['id', 'ok', 'result', 'schemaVersion']
    : ['error', 'id', 'ok', 'schemaVersion']);
  if (value.schemaVersion !== 1 || token(value.id) !== expectedId) fail();
  if (value.ok) {
    if (!isJsonValue(value.result)) fail();
    return { schemaVersion: 1, id: expectedId, ok: true, result: value.result };
  }
  if (!isJsonObject(value.error)) fail();
  exact(value.error, ['code', 'message']);
  const message = value.error.message;
  if (typeof message !== 'string' || message.length === 0 || message.length > 512) fail();
  return {
    schemaVersion: 1,
    id: expectedId,
    ok: false,
    error: { code: token(value.error.code), message },
  };
}
