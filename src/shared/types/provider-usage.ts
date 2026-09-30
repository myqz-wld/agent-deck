import type { UsageResetCreditsDto } from '@contracts/usage-reset';
export type ProviderUsageProviderId =
  | 'claude-code'
  | 'codex-cli'
  | 'grok-build';

export type ProviderUsageStatus =
  | 'ok'
  | 'not_subscribed'
  | 'unsupported'
  | 'unavailable'
  | 'error';

export type ProviderUsageWindowId = 'current' | 'weekly';

export interface ProviderUsageWindow {
  id: ProviderUsageWindowId;
  /** Provider quota identity for model-specific limits; omitted for the default quota. */
  quotaId?: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes?: number | null;
}

export interface ProviderUsageSnapshot {
  provider: ProviderUsageProviderId;
  label: string;
  status: ProviderUsageStatus;
  windows: ProviderUsageWindow[];
  updatedAt: number;
  message?: string;
  resetCredits?: UsageResetCreditsDto;
}

export interface ProviderUsageSnapshotResult {
  snapshots: ProviderUsageSnapshot[];
}
export type {
  UsageProviderResetParams as ProviderUsageResetRequest,
  UsageProviderResetResult as ProviderUsageResetResult,
} from '@contracts/usage-reset';
