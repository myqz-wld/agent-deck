import {
  parseProviderSessionAttachResult,
  parseProviderSessionAttachSpec,
  parseProviderSessionLaunchResult,
  parseProviderSessionLaunchSpec,
  parseProviderSessionStopResult,
  parseProviderSessionStopSpec,
  parseProviderSessionSupervisorCapabilities,
  type ProviderSessionAttachResult,
  type ProviderSessionAttachSpec,
  type ProviderSessionLaunchResult,
  type ProviderSessionLaunchSpec,
  type ProviderSessionStopResult,
  type ProviderSessionStopSpec,
  type ProviderSessionSupervisorCapabilities,
} from '@contracts/index';

import type { ProviderSessionSupervisorErrorCode } from './supervisor-port';

export const PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION = 1;
export const PROVIDER_SESSION_SUPERVISOR_MAX_FRAME_BYTES = 64 * 1024;

export type ProviderSessionSupervisorTransportMethod =
  | 'attach'
  | 'capabilities'
  | 'close'
  | 'launch'
  | 'stop';

export type ProviderSessionSupervisorTransportParams =
  | ProviderSessionAttachSpec
  | ProviderSessionLaunchSpec
  | ProviderSessionStopSpec
  | null;

export interface ProviderSessionSupervisorTransportRequest {
  readonly schemaVersion: typeof PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION;
  readonly method: ProviderSessionSupervisorTransportMethod;
  readonly params: ProviderSessionSupervisorTransportParams;
  readonly requestId: string;
}

export interface ProviderSessionSupervisorCloseResult {
  readonly closed: true;
}

export type ProviderSessionSupervisorTransportResult =
  | ProviderSessionAttachResult
  | ProviderSessionLaunchResult
  | ProviderSessionStopResult
  | ProviderSessionSupervisorCapabilities
  | ProviderSessionSupervisorCloseResult;

export type ProviderSessionSupervisorTransportResponse =
  | {
      readonly schemaVersion: typeof PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION;
      readonly ok: true;
      readonly requestId: string;
      readonly result: ProviderSessionSupervisorTransportResult;
    }
  | {
      readonly schemaVersion: typeof PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION;
      readonly error: {
        readonly code: ProviderSessionSupervisorErrorCode;
        readonly message: string;
      };
      readonly ok: false;
      readonly requestId: string;
    };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const METHODS = new Set<ProviderSessionSupervisorTransportMethod>([
  'attach',
  'capabilities',
  'close',
  'launch',
  'stop',
]);
const ERROR_CODES = new Set<ProviderSessionSupervisorErrorCode>([
  'closed',
  'conflict',
  'identity-changed',
  'limit',
  'not-found',
  'teardown-failed',
  'unavailable',
]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} is invalid`);
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function method(value: unknown): ProviderSessionSupervisorTransportMethod {
  if (!METHODS.has(value as ProviderSessionSupervisorTransportMethod)) {
    throw new Error('provider supervisor transport method is invalid');
  }
  return value as ProviderSessionSupervisorTransportMethod;
}

function parseParams(
  value: unknown,
  selectedMethod: ProviderSessionSupervisorTransportMethod,
): ProviderSessionSupervisorTransportParams {
  if (selectedMethod === 'attach') return parseProviderSessionAttachSpec(value);
  if (selectedMethod === 'launch') return parseProviderSessionLaunchSpec(value);
  if (selectedMethod === 'stop') return parseProviderSessionStopSpec(value);
  if (value !== null) throw new Error('provider supervisor transport params are invalid');
  return null;
}

export function parseProviderSessionSupervisorTransportRequest(
  value: unknown,
): ProviderSessionSupervisorTransportRequest {
  const raw = object(value, 'provider supervisor transport request');
  exactKeys(raw, ['method', 'params', 'requestId', 'schemaVersion'],
    'provider supervisor transport request');
  if (raw.schemaVersion !== PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION) {
    throw new Error('provider supervisor transport schema is invalid');
  }
  const selectedMethod = method(raw.method);
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
    method: selectedMethod,
    params: parseParams(raw.params, selectedMethod),
    requestId: token(raw.requestId, 'provider supervisor transport request id'),
  });
}

function parseResult(
  value: unknown,
  selectedMethod: ProviderSessionSupervisorTransportMethod,
): ProviderSessionSupervisorTransportResult {
  if (selectedMethod === 'attach') return parseProviderSessionAttachResult(value);
  if (selectedMethod === 'capabilities') return parseProviderSessionSupervisorCapabilities(value);
  if (selectedMethod === 'launch') return parseProviderSessionLaunchResult(value);
  if (selectedMethod === 'stop') return parseProviderSessionStopResult(value);
  const raw = object(value, 'provider supervisor close result');
  exactKeys(raw, ['closed'], 'provider supervisor close result');
  if (raw.closed !== true) throw new Error('provider supervisor close result is invalid');
  return Object.freeze({ closed: true });
}

export interface ProviderSessionSupervisorAttachReady {
  readonly schemaVersion: typeof PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION;
  readonly ready: true;
  readonly requestId: string;
}

export function parseProviderSessionSupervisorAttachReady(
  value: unknown,
  expectedRequestId: string,
): ProviderSessionSupervisorAttachReady {
  const raw = object(value, 'provider supervisor attach readiness');
  exactKeys(raw, ['ready', 'requestId', 'schemaVersion'],
    'provider supervisor attach readiness');
  if (raw.schemaVersion !== PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION || raw.ready !== true ||
      raw.requestId !== token(expectedRequestId, 'provider supervisor attach request id')) {
    throw new Error('provider supervisor attach readiness is invalid');
  }
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
    ready: true,
    requestId: raw.requestId as string,
  });
}

export function parseProviderSessionSupervisorTransportResponse(
  value: unknown,
  selectedMethod: ProviderSessionSupervisorTransportMethod,
  expectedRequestId: string,
): ProviderSessionSupervisorTransportResponse {
  const raw = object(value, 'provider supervisor transport response');
  if (raw.schemaVersion !== PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION ||
      raw.requestId !== token(expectedRequestId, 'provider supervisor expected request id')) {
    throw new Error('provider supervisor transport response identity is invalid');
  }
  if (raw.ok === true) {
    exactKeys(raw, ['ok', 'requestId', 'result', 'schemaVersion'],
      'provider supervisor transport response');
    return Object.freeze({
      schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
      ok: true,
      requestId: raw.requestId as string,
      result: parseResult(raw.result, selectedMethod),
    });
  }
  if (raw.ok !== false) throw new Error('provider supervisor transport response is invalid');
  exactKeys(raw, ['error', 'ok', 'requestId', 'schemaVersion'],
    'provider supervisor transport response');
  const error = object(raw.error, 'provider supervisor transport error');
  exactKeys(error, ['code', 'message'], 'provider supervisor transport error');
  if (!ERROR_CODES.has(error.code as ProviderSessionSupervisorErrorCode) ||
      typeof error.message !== 'string' || error.message.length === 0 ||
      Buffer.byteLength(error.message) > 256 || CONTROL.test(error.message)) {
    throw new Error('provider supervisor transport error is invalid');
  }
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
    error: Object.freeze({
      code: error.code as ProviderSessionSupervisorErrorCode,
      message: error.message,
    }),
    ok: false,
    requestId: raw.requestId as string,
  });
}
