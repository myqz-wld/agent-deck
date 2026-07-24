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

export interface GrokBillingResponseLike {
  config?: {
    creditUsagePercent?: number | null;
    currentPeriod?: {
      type?: string | null;
      start?: string | null;
      end?: string | null;
    } | null;
    monthlyLimit?: { val?: number | null } | null;
    used?: { val?: number | null } | null;
    billingPeriodStart?: string | null;
    billingPeriodEnd?: string | null;
  } | null;
  subscription_tier?: string | null;
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

export function notSubscribedUsageSnapshot(
  provider: ProviderUsageProviderId,
  label: string,
  message: string,
  updatedAt?: number,
): ProviderUsageSnapshot {
  return usageSnapshot({ provider, label, status: 'not_subscribed', message, updatedAt });
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
  if (response.subscription_type === null && !response.rate_limits_available) {
    return notSubscribedUsageSnapshot(
      'claude-code',
      'Claude',
      '当前 Claude 账号没有可展示的额度信息',
      updatedAt,
    );
  }

  if (!response.rate_limits_available || !response.rate_limits) {
    return unavailableUsageSnapshot(
      'claude-code',
      'Claude',
      '当前 Claude 登录方式暂不支持读取额度信息',
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
      'Claude 暂未返回可展示的额度信息',
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
      'Codex 暂未返回账户额度信息',
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
      'Codex 暂未返回可展示的额度信息',
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

export function buildGrokUsageSnapshot(
  response: GrokBillingResponseLike,
  updatedAt = Date.now(),
): ProviderUsageSnapshot {
  const config = response.config;
  if (!config) {
    return unavailableUsageSnapshot(
      'grok-build',
      'Grok',
      'Grok 暂未返回账户额度信息',
      updatedAt,
    );
  }

  const periodType = config.currentPeriod?.type?.toUpperCase() ?? '';
  const periodStart =
    normalizeIsoDate(config.currentPeriod?.start) ??
    normalizeIsoDate(config.billingPeriodStart);
  const periodEnd =
    normalizeIsoDate(config.currentPeriod?.end) ??
    normalizeIsoDate(config.billingPeriodEnd);
  const usedPercent =
    normalizePercent(config.creditUsagePercent) ??
    percentFromAmounts(config.used?.val, config.monthlyLimit?.val);
  if (usedPercent === null && periodEnd === null) {
    return unavailableUsageSnapshot(
      'grok-build',
      'Grok',
      'Grok 暂未返回可展示的额度信息',
      updatedAt,
    );
  }

  const weekly = periodType.includes('WEEK');
  return usageSnapshot(
    {
      provider: 'grok-build',
      label: 'Grok',
      status: 'ok',
      updatedAt,
    },
    [
      {
        id: weekly ? 'weekly' : 'current',
        label: weekly
          ? '周用量'
          : periodType.includes('MONTH')
            ? '月用量'
            : '当前周期',
        usedPercent,
        resetsAt: periodEnd,
        windowMinutes: minutesBetween(periodStart, periodEnd),
      },
    ],
  );
}

export function formatErrorMessage(err: unknown): string {
  void err;
  return '额度信息读取失败，请稍后重试';
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

function percentFromAmounts(
  used: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return null;
  }
  return (used / limit) * 100;
}

function minutesBetween(
  start: string | null,
  end: string | null,
): number | null {
  if (!start || !end) return null;
  const duration = new Date(end).getTime() - new Date(start).getTime();
  return duration > 0 && Number.isFinite(duration) ? duration / 60_000 : null;
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
