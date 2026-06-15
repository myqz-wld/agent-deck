export type ProviderUsageProviderId =
  | 'claude-code'
  | 'codex-cli'
  | 'deepseek-claude-code';

export type ProviderUsageStatus =
  | 'ok'
  | 'not_subscribed'
  | 'unsupported'
  | 'unavailable'
  | 'error';

export type ProviderUsageWindowId = 'current' | 'weekly';

export interface ProviderUsageWindow {
  id: ProviderUsageWindowId;
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
}

export interface ProviderUsageSnapshotResult {
  snapshots: ProviderUsageSnapshot[];
}
