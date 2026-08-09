import { FeishuGatewayError } from '@gateways/im';
import type { FeishuConnectionHealth } from './types';

const HEALTH_FIELDS = [
  'generation',
  'instanceId',
  'lastErrorCode',
  'reconnectAttempts',
  'state',
  'updatedAt',
] as const;
const HEALTH_STATES = new Set([
  'connected',
  'failed',
  'reconnecting',
  'starting',
  'stopped',
]);
const FAILURE_CODES = new Set([
  'health-counter-overflow',
  'health-store-error',
  'reconnect-timeout',
  'sdk-construction-error',
  'sdk-start-error',
  'sdk-terminal-error',
  'startup-timeout',
]);

function fail(): never {
  throw new FeishuGatewayError(
    'invalid_configuration',
    'Persisted Feishu connection health is invalid',
  );
}

function safeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validateFeishuConnectionHealth(
  value: unknown,
  expectedInstanceId: string,
): FeishuConnectionHealth | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== HEALTH_FIELDS.length ||
    keys.some((key, index) => key !== [...HEALTH_FIELDS].sort()[index])
  ) fail();
  if (
    record.instanceId !== expectedInstanceId ||
    typeof record.state !== 'string' ||
    !HEALTH_STATES.has(record.state)
  ) fail();
  if (
    !safeCounter(record.generation) ||
    !safeCounter(record.reconnectAttempts) ||
    !safeCounter(record.updatedAt)
  ) fail();
  const failed = record.state === 'failed';
  if (
    (failed && (typeof record.lastErrorCode !== 'string' ||
      record.lastErrorCode.length > 64 || !FAILURE_CODES.has(record.lastErrorCode))) ||
    (!failed && record.lastErrorCode !== null)
  ) fail();
  return Object.freeze({
    instanceId: record.instanceId,
    state: record.state,
    generation: record.generation,
    reconnectAttempts: record.reconnectAttempts,
    lastErrorCode: record.lastErrorCode,
    updatedAt: record.updatedAt,
  }) as FeishuConnectionHealth;
}
