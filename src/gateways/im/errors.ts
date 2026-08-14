import { AgentDeckClientErrorCode } from '@contracts/index';
import type { ClassifiedGatewayError } from './types';

const CLIENT_ERROR_CODES = new Set<string>(Object.values(AgentDeckClientErrorCode));
const GATEWAY_ERROR_CODES = new Set([
  'cursor_regression',
  'delivery_failed',
  'delivery_generation_lost',
  'delivery_ambiguous',
  'delivery_exhausted',
  'delivery_missing',
  'delivery_too_large',
  'event_identity_mismatch',
  'event_in_progress',
  'gateway_closed',
  'identity_conflict',
  'input_too_large',
  'invalid_command',
  'invalid_confirmation',
  'invalid_configuration',
  'invalid_core_event',
  'invalid_core_response',
  'invalid_event',
  'invalid_nonce',
  'invalid_pending_action',
  'lifecycle_failed',
  'platform_window_exceeded',
  'pending_context_changed',
  'rate_limited',
  'reconciliation_required',
  'session_not_selected',
  'subscription_failed',
  'subscription_limit_exceeded',
  'unknown_command',
  'unknown_field',
]);

function isAllowedCode(code: string): boolean {
  return CLIENT_ERROR_CODES.has(code) || GATEWAY_ERROR_CODES.has(code);
}

function fixedMessage(code: string): string {
  if (code === 'platform_window_exceeded') return 'Feishu callback window elapsed';
  if (code === 'delivery_failed') return 'Feishu delivery failed';
  if (code === AgentDeckClientErrorCode.WorkerOffline) return 'Authoritative Worker is offline';
  if (code === AgentDeckClientErrorCode.DeadlineExceeded) return 'Core request deadline elapsed';
  return `Feishu gateway request failed: ${code}`;
}

function safeRevision(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

export class FeishuGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly currentRevision?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FeishuGatewayError';
  }
}

export class FeishuGatewayLifecycleError extends AggregateError {
  readonly code = 'lifecycle_failed';
  readonly retryable = true;

  constructor(errors: readonly unknown[], operation: 'close' | 'start') {
    super(
      errors.map(() => new Error('Feishu gateway lifecycle dependency failed')),
      `Feishu gateway ${operation} failed`,
    );
    this.name = 'FeishuGatewayLifecycleError';
  }
}

export function classifyGatewayError(error: unknown): ClassifiedGatewayError {
  if (error instanceof FeishuGatewayError) {
    const code = isAllowedCode(error.code)
      ? error.code
      : AgentDeckClientErrorCode.InternalError;
    return {
      code,
      retryable: code === AgentDeckClientErrorCode.InternalError ? true : error.retryable,
      message: fixedMessage(code),
      currentRevision: safeRevision(error.currentRevision),
    };
  }
  if (error instanceof FeishuGatewayLifecycleError) {
    return { code: error.code, retryable: true, message: fixedMessage(error.code) };
  }
  if (error instanceof Error) {
    const candidate = error as Error & {
      code?: unknown;
      retryable?: unknown;
      currentRevision?: unknown;
    };
    if (typeof candidate.code === 'string' && CLIENT_ERROR_CODES.has(candidate.code)) {
      return {
        code: candidate.code,
        retryable:
          candidate.retryable === true ||
          candidate.code === AgentDeckClientErrorCode.WorkerOffline ||
          candidate.code === AgentDeckClientErrorCode.DeadlineExceeded ||
          candidate.code === AgentDeckClientErrorCode.InternalError,
        message: fixedMessage(candidate.code),
        currentRevision: safeRevision(candidate.currentRevision),
      };
    }
  }
  return {
    code: AgentDeckClientErrorCode.InternalError,
    retryable: true,
    message: 'Feishu gateway dependency failed',
  };
}
