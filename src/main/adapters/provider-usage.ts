import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type {
  ProviderUsageProviderId,
  ProviderUsageSnapshot,
  ProviderUsageStatus,
  ProviderUsageWindow,
  ProviderUsageWindowId,
} from '@shared/types';

export interface CodexRateLimitWindowLike {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateLimitSnapshotLike {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindowLike | null;
  secondary?: CodexRateLimitWindowLike | null;
}

export interface CodexAccountRateLimitsResponseLike {
  rateLimits?: CodexRateLimitSnapshotLike | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshotLike | undefined> | null;
}

type ClaudeRateLimitWindow =
  NonNullable<NonNullable<SDKControlGetUsageResponse['rate_limits']>['five_hour']>;

interface SnapshotBase {
  provider: ProviderUsageProviderId;
  label: string;
  status: ProviderUsageStatus;
  message?: string;
  updatedAt?: number;
}

export function usageSnapshot(
  base: SnapshotBase,
  windows: ProviderUsageWindow[] = [],
): ProviderUsageSnapshot {
  return {
    provider: base.provider,
    label: base.label,
    status: base.status,
    windows,
    updatedAt: base.updatedAt ?? Date.now(),
    ...(base.message ? { message: base.message } : {}),
  };
}

export function unsupportedUsageSnapshot(
  provider: ProviderUsageProviderId,
  label: string,
  message: string,
  updatedAt?: number,
): ProviderUsageSnapshot {
  return usageSnapshot({ provider, label, status: 'unsupported', message, updatedAt });
}

export function unavailableUsageSnapshot(
  provider: ProviderUsageProviderId,
  label: string,
  message: string,
  updatedAt?: number,
): ProviderUsageSnapshot {
  return usageSnapshot({ provider, label, status: 'unavailable', message, updatedAt });
}

export function errorUsageSnapshot(
  provider: ProviderUsageProviderId,
  label: string,
  err: unknown,
  updatedAt?: number,
): ProviderUsageSnapshot {
  return usageSnapshot({
    provider,
    label,
    status: 'error',
    message: formatErrorMessage(err),
    updatedAt,
  });
}

export function buildClaudeUsageSnapshot(
  response: SDKControlGetUsageResponse,
  updatedAt = Date.now(),
): ProviderUsageSnapshot {
  if (!response.rate_limits_available || !response.rate_limits) {
    return unavailableUsageSnapshot(
      'claude-code',
      'Claude',
      '当前 Claude 登录方式不提供订阅限额窗口',
      updatedAt,
    );
  }

  const weekly = response.rate_limits.seven_day ?? response.rate_limits.seven_day_oauth_apps;
  const windows = [
    buildClaudeWindow('current', '当前窗口', response.rate_limits.five_hour),
    buildClaudeWindow('weekly', '周用量', weekly),
  ];
  const hasWindowData = windows.some((w) => w.usedPercent !== null || w.resetsAt !== null);
  if (!hasWindowData) {
    return unavailableUsageSnapshot(
      'claude-code',
      'Claude',
      'Claude 未返回可展示的限额窗口',
      updatedAt,
    );
  }

  return usageSnapshot(
    {
      provider: 'claude-code',
      label: 'Claude',
      status: 'ok',
      updatedAt,
    },
    windows,
  );
}

export function buildCodexUsageSnapshot(
  response: CodexAccountRateLimitsResponseLike,
  updatedAt = Date.now(),
): ProviderUsageSnapshot {
  const limits = chooseCodexRateLimitSnapshot(response);
  if (!limits) {
    return unavailableUsageSnapshot(
      'codex-cli',
      'Codex',
      'Codex 未返回账户限额窗口',
      updatedAt,
    );
  }

  const windows = [
    buildCodexWindow('current', '当前窗口', limits.primary),
    buildCodexWindow('weekly', '周用量', limits.secondary),
  ];
  const hasWindowData = windows.some((w) => w.usedPercent !== null || w.resetsAt !== null);
  if (!hasWindowData) {
    return unavailableUsageSnapshot(
      'codex-cli',
      'Codex',
      'Codex 未返回可展示的限额窗口',
      updatedAt,
    );
  }

  return usageSnapshot(
    {
      provider: 'codex-cli',
      label: 'Codex',
      status: 'ok',
      updatedAt,
    },
    windows,
  );
}

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function buildClaudeWindow(
  id: ProviderUsageWindowId,
  label: string,
  window: ClaudeRateLimitWindow | null | undefined,
): ProviderUsageWindow {
  return {
    id,
    label,
    usedPercent: normalizePercent(window?.utilization),
    resetsAt: normalizeIsoDate(window?.resets_at),
  };
}

function buildCodexWindow(
  id: ProviderUsageWindowId,
  label: string,
  window: CodexRateLimitWindowLike | null | undefined,
): ProviderUsageWindow {
  return {
    id,
    label,
    usedPercent: normalizePercent(window?.usedPercent),
    resetsAt: normalizeEpochDate(window?.resetsAt),
    windowMinutes: normalizeWindowMinutes(window?.windowDurationMins),
  };
}

function chooseCodexRateLimitSnapshot(
  response: CodexAccountRateLimitsResponseLike,
): CodexRateLimitSnapshotLike | null {
  const byLimit = response.rateLimitsByLimitId ?? null;
  const values = Object.values(byLimit ?? {}).filter(Boolean) as CodexRateLimitSnapshotLike[];
  return (
    byLimit?.codex ??
    values.find((entry) => entry.limitId === 'codex') ??
    response.rateLimits ??
    values[0] ??
    null
  );
}

function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function normalizeWindowMinutes(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizeIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function normalizeEpochDate(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}
