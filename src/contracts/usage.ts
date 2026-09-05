import { SessionConsoleContractError } from './session-console-common';

export const USAGE_RATE_MAX_ITEMS = 256;
export const USAGE_DAILY_MAX_ITEMS = 5_000;
export const USAGE_PROVIDER_MAX_ITEMS = 3;
export const USAGE_PROVIDER_MAX_WINDOWS = 64;
// Leave headroom for the daemon response envelope inside the 4 MiB transport frame.
export const USAGE_RESPONSE_MAX_BYTES = 3 * 1024 * 1024;

export interface UsageTokenParams {
  includeDaily: boolean;
  dailyLimit: number;
}

export interface UsageRateDto { bucketKey: string; outputTokens: number }

export interface UsageDailyDto {
  bucketKey: string;
  day: string;
  providerTotalTokens: number | null;
  providerTotalApplicable: boolean;
  inputTotalTokens: number | null;
  inputTotalApplicable: boolean;
  outputTokens: number | null;
  outputApplicable: boolean;
  reasoningTokens: number | null;
  reasoningApplicable: boolean;
  cacheReadTokens: number | null;
  cacheReadApplicable: boolean;
  cacheCreationTokens: number | null;
  cacheCreationApplicable: boolean;
}

export interface UsageTokenResult {
  rates: UsageRateDto[];
  topToday: UsageRateDto[];
  daily: UsageDailyDto[];
  dailyTruncated: boolean;
  today: string;
  revision: number;
}

export type UsageProviderIdDto = 'claude-code' | 'codex-cli' | 'grok-build';
export type UsageProviderStatusDto =
  | 'ok'
  | 'not_subscribed'
  | 'unsupported'
  | 'unavailable'
  | 'error';

export interface UsageProviderWindowDto {
  id: 'current' | 'weekly';
  quotaId?: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes?: number | null;
}

export interface UsageProviderSnapshotDto {
  provider: UsageProviderIdDto;
  label: string;
  status: UsageProviderStatusDto;
  windows: UsageProviderWindowDto[];
  updatedAt: number;
  message?: string;
}

export interface UsageProviderParams { force: boolean }
export interface UsageProviderResult {
  snapshots: UsageProviderSnapshotDto[];
  revision: number;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(field: string): never { throw new SessionConsoleContractError(field); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(field);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function text(value: unknown, field: string, maximum: number, nonempty = false): string {
  if (
    typeof value !== 'string' || (nonempty && value.length === 0) || CONTROL.test(value) ||
    bytes(value) > maximum
  ) fail(field);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}
function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(field);
  }
  return value as number;
}
function count(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}
function finite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(field);
  return value;
}
function boundedResult<T>(value: T, field: string): T {
  if (bytes(JSON.stringify(value)) > USAGE_RESPONSE_MAX_BYTES) fail(field);
  return value;
}

function calendarDay(value: unknown, field: string): string {
  const parsed = text(value, field, 10, true);
  if (!DAY.test(parsed)) fail(field);
  const [year, month, dayOfMonth] = parsed.split('-').map(Number) as [number, number, number];
  const normalized = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== dayOfMonth
  ) fail(field);
  return parsed;
}

export function parseUsageTokenParams(value: unknown): UsageTokenParams {
  const raw = object(value, 'usage.tokens.get.params');
  exact(raw, ['dailyLimit', 'includeDaily'], 'usage.tokens.get.params');
  const dailyLimit = integer(raw.dailyLimit, 'usage.tokens.get.dailyLimit', USAGE_DAILY_MAX_ITEMS);
  if (dailyLimit < 1) fail('usage.tokens.get.dailyLimit');
  return {
    includeDaily: boolean(raw.includeDaily, 'usage.tokens.get.includeDaily'),
    dailyLimit,
  };
}

export function parseUsageProviderParams(value: unknown): UsageProviderParams {
  const raw = object(value, 'usage.providers.get.params');
  exact(raw, ['force'], 'usage.providers.get.params');
  return { force: boolean(raw.force, 'usage.providers.get.force') };
}

function rate(value: unknown, field: string): UsageRateDto {
  const raw = object(value, field);
  exact(raw, ['bucketKey', 'outputTokens'], field);
  return {
    bucketKey: text(raw.bucketKey, `${field}.bucketKey`, 512, true),
    outputTokens: integer(raw.outputTokens, `${field}.outputTokens`),
  };
}

function daily(value: unknown, field: string): UsageDailyDto {
  const raw = object(value, field);
  exact(raw, [
    'bucketKey', 'cacheCreationApplicable', 'cacheCreationTokens', 'cacheReadApplicable',
    'cacheReadTokens', 'day', 'inputTotalApplicable', 'inputTotalTokens',
    'outputApplicable', 'outputTokens', 'providerTotalApplicable', 'providerTotalTokens',
    'reasoningApplicable', 'reasoningTokens',
  ], field);
  const day = calendarDay(raw.day, `${field}.day`);
  return {
    bucketKey: text(raw.bucketKey, `${field}.bucketKey`, 512, true),
    day,
    providerTotalTokens: count(raw.providerTotalTokens, `${field}.providerTotalTokens`),
    providerTotalApplicable: boolean(raw.providerTotalApplicable, `${field}.providerTotalApplicable`),
    inputTotalTokens: count(raw.inputTotalTokens, `${field}.inputTotalTokens`),
    inputTotalApplicable: boolean(raw.inputTotalApplicable, `${field}.inputTotalApplicable`),
    outputTokens: count(raw.outputTokens, `${field}.outputTokens`),
    outputApplicable: boolean(raw.outputApplicable, `${field}.outputApplicable`),
    reasoningTokens: count(raw.reasoningTokens, `${field}.reasoningTokens`),
    reasoningApplicable: boolean(raw.reasoningApplicable, `${field}.reasoningApplicable`),
    cacheReadTokens: count(raw.cacheReadTokens, `${field}.cacheReadTokens`),
    cacheReadApplicable: boolean(raw.cacheReadApplicable, `${field}.cacheReadApplicable`),
    cacheCreationTokens: count(raw.cacheCreationTokens, `${field}.cacheCreationTokens`),
    cacheCreationApplicable: boolean(raw.cacheCreationApplicable, `${field}.cacheCreationApplicable`),
  };
}

export function parseUsageTokenResult(value: unknown, dailyLimit: number): UsageTokenResult {
  const raw = object(value, 'usage.tokens.get.result');
  exact(raw, [
    'daily', 'dailyTruncated', 'rates', 'revision', 'today', 'topToday',
  ], 'usage.tokens.get.result');
  if (!Array.isArray(raw.rates) || raw.rates.length > USAGE_RATE_MAX_ITEMS) fail('usage.tokens.get.rates');
  if (!Array.isArray(raw.topToday) || raw.topToday.length > USAGE_RATE_MAX_ITEMS) fail('usage.tokens.get.topToday');
  if (!Array.isArray(raw.daily) || raw.daily.length > dailyLimit) fail('usage.tokens.get.daily');
  const rates = raw.rates.map((item, index) => rate(item, `usage.tokens.get.rates[${index}]`));
  const topToday = raw.topToday.map((item, index) =>
    rate(item, `usage.tokens.get.topToday[${index}]`));
  const dailyRows = raw.daily.map((item, index) =>
    daily(item, `usage.tokens.get.daily[${index}]`));
  if (new Set(rates.map((item) => item.bucketKey)).size !== rates.length) {
    fail('usage.tokens.get.rates');
  }
  if (new Set(topToday.map((item) => item.bucketKey)).size !== topToday.length) {
    fail('usage.tokens.get.topToday');
  }
  if (
    new Set(dailyRows.map((item) => `${item.bucketKey}\u0000${item.day}`)).size !==
    dailyRows.length
  ) fail('usage.tokens.get.daily');
  const today = calendarDay(raw.today, 'usage.tokens.get.today');
  return boundedResult({
    rates,
    topToday,
    daily: dailyRows,
    dailyTruncated: boolean(raw.dailyTruncated, 'usage.tokens.get.dailyTruncated'),
    today,
    revision: integer(raw.revision, 'usage.tokens.get.revision'),
  }, 'usage.tokens.get.result');
}

function window(value: unknown, field: string): UsageProviderWindowDto {
  const raw = object(value, field);
  const keys = ['id', 'label', 'resetsAt', 'usedPercent'];
  if (Object.hasOwn(raw, 'windowMinutes')) keys.push('windowMinutes');
  if (Object.hasOwn(raw, 'quotaId')) keys.push('quotaId');
  exact(raw, keys, field);
  if (raw.id !== 'current' && raw.id !== 'weekly') fail(`${field}.id`);
  const resetsAt = raw.resetsAt === null
    ? null
    : text(raw.resetsAt, `${field}.resetsAt`, 128, true);
  if (resetsAt !== null && !Number.isFinite(Date.parse(resetsAt))) fail(`${field}.resetsAt`);
  return {
    id: raw.id,
    ...(Object.hasOwn(raw, 'quotaId')
      ? { quotaId: text(raw.quotaId, `${field}.quotaId`, 512, true) }
      : {}),
    label: text(raw.label, `${field}.label`, 512, true),
    usedPercent: finite(raw.usedPercent, `${field}.usedPercent`),
    resetsAt,
    ...(Object.hasOwn(raw, 'windowMinutes')
      ? { windowMinutes: raw.windowMinutes === null
          ? null
          : finite(raw.windowMinutes, `${field}.windowMinutes`) }
      : {}),
  };
}

function snapshot(value: unknown, field: string): UsageProviderSnapshotDto {
  const raw = object(value, field);
  const keys = Object.hasOwn(raw, 'message')
    ? ['label', 'message', 'provider', 'status', 'updatedAt', 'windows']
    : ['label', 'provider', 'status', 'updatedAt', 'windows'];
  exact(raw, keys, field);
  const providers: readonly UsageProviderIdDto[] = ['claude-code', 'codex-cli', 'grok-build'];
  const statuses: readonly UsageProviderStatusDto[] = [
    'ok', 'not_subscribed', 'unsupported', 'unavailable', 'error',
  ];
  if (!providers.includes(raw.provider as UsageProviderIdDto)) fail(`${field}.provider`);
  if (!statuses.includes(raw.status as UsageProviderStatusDto)) fail(`${field}.status`);
  if (!Array.isArray(raw.windows) || raw.windows.length > USAGE_PROVIDER_MAX_WINDOWS) {
    fail(`${field}.windows`);
  }
  const windows = raw.windows.map((item, index) => window(item, `${field}.windows[${index}]`));
  if (new Set(windows.map((item) => JSON.stringify([item.quotaId ?? null, item.id]))).size !== windows.length) {
    fail(`${field}.windows`);
  }
  return {
    provider: raw.provider as UsageProviderIdDto,
    label: text(raw.label, `${field}.label`, 512, true),
    status: raw.status as UsageProviderStatusDto,
    windows,
    updatedAt: integer(raw.updatedAt, `${field}.updatedAt`),
    ...(Object.hasOwn(raw, 'message')
      ? { message: text(raw.message, `${field}.message`, 4 * 1024) }
      : {}),
  };
}

export function parseUsageProviderResult(value: unknown): UsageProviderResult {
  const raw = object(value, 'usage.providers.get.result');
  exact(raw, ['revision', 'snapshots'], 'usage.providers.get.result');
  if (!Array.isArray(raw.snapshots) || raw.snapshots.length > USAGE_PROVIDER_MAX_ITEMS) {
    fail('usage.providers.get.snapshots');
  }
  const snapshots = raw.snapshots.map((item, index) => snapshot(item, `usage.providers.get.snapshots[${index}]`));
  if (new Set(snapshots.map((item) => item.provider)).size !== snapshots.length) {
    fail('usage.providers.get.snapshots');
  }
  return boundedResult({
    snapshots,
    revision: integer(raw.revision, 'usage.providers.get.revision'),
  }, 'usage.providers.get.result');
}
