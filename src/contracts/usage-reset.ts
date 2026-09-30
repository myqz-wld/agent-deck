import { SessionConsoleContractError } from './session-console-common';

export interface UsageResetCreditsDto {
  availableCount: number | null;
  /** Binds confirmation to the account whose allowance was displayed. */
  accountId: string | null;
}

export interface UsageProviderResetParams {
  provider: 'codex-cli';
  accountId: string;
  idempotencyKey: string;
}

export type UsageProviderResetOutcome = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';
export interface UsageProviderResetResult { outcome: UsageProviderResetOutcome }

function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionConsoleContractError(field);
  }
  const raw = value as Record<string, unknown>;
  const actual = Object.keys(raw).sort();
  const expected = keys.sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SessionConsoleContractError(field);
  }
  return raw;
}

export function parseUsageResetCredits(value: unknown): UsageResetCreditsDto {
  const field = 'usage.resetCredits';
  const raw = object(value, ['availableCount', 'accountId'], field);
  if (raw.availableCount !== null &&
    (!Number.isSafeInteger(raw.availableCount) || (raw.availableCount as number) < 0)) {
    throw new SessionConsoleContractError(field);
  }
  if (raw.accountId !== null && !validAccountId(raw.accountId)) {
    throw new SessionConsoleContractError(field);
  }
  return { availableCount: raw.availableCount as number | null, accountId: raw.accountId as string | null };
}

function validAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
}

export function parseUsageProviderResetParams(value: unknown): UsageProviderResetParams {
  const field = 'usage.providers.reset.params';
  const raw = object(value, ['provider', 'accountId', 'idempotencyKey'], field);
  if (raw.provider !== 'codex-cli' || !validAccountId(raw.accountId) ||
    typeof raw.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.idempotencyKey)) {
    throw new SessionConsoleContractError(field);
  }
  return { provider: raw.provider, accountId: raw.accountId, idempotencyKey: raw.idempotencyKey };
}

export function parseUsageProviderResetResult(value: unknown): UsageProviderResetResult {
  const field = 'usage.providers.reset.result';
  const raw = object(value, ['outcome'], field);
  const outcomes: readonly unknown[] = ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'];
  if (!outcomes.includes(raw.outcome)) throw new SessionConsoleContractError(field);
  return { outcome: raw.outcome as UsageProviderResetOutcome };
}
