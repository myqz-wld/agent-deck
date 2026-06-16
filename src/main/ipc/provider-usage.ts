import { IpcInvoke } from '@shared/ipc-channels';
import type {
  ProviderUsageProviderId,
  ProviderUsageSnapshot,
  ProviderUsageSnapshotResult,
} from '@shared/types';
import { adapterRegistry } from '@main/adapters/registry';
import { errorUsageSnapshot, unavailableUsageSnapshot } from '@main/adapters/provider-usage';
import { on } from './_helpers';

const PROVIDER_ORDER: ReadonlyArray<ProviderUsageProviderId> = [
  'claude-code',
  'codex-cli',
  'deepseek-claude-code',
];

const PROVIDER_LABELS: Record<ProviderUsageProviderId, string> = {
  'claude-code': 'Claude',
  'codex-cli': 'Codex',
  'deepseek-claude-code': 'Deepseek',
};

export const PROVIDER_USAGE_CACHE_TTL_MS = 55_000;

let cachedResult: { result: ProviderUsageSnapshotResult; fetchedAt: number } | null = null;
let inFlightFetch: Promise<ProviderUsageSnapshotResult> | null = null;

export async function providerUsageSnapshotHandler(): Promise<ProviderUsageSnapshotResult> {
  const now = Date.now();
  if (cachedResult && now - cachedResult.fetchedAt < PROVIDER_USAGE_CACHE_TTL_MS) {
    return cachedResult.result;
  }
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = fetchProviderUsageSnapshots().finally(() => {
    inFlightFetch = null;
  });
  return inFlightFetch;
}

async function fetchProviderUsageSnapshots(): Promise<ProviderUsageSnapshotResult> {
  const snapshots = await Promise.all(PROVIDER_ORDER.map(readAdapterSnapshot));
  const result = { snapshots };
  cachedResult = { result, fetchedAt: Date.now() };
  return result;
}

/** Test seam: reset IPC cache/dedupe state between isolated handler tests. */
export function _resetProviderUsageCacheForTesting(): void {
  cachedResult = null;
  inFlightFetch = null;
}

export function registerProviderUsageIpc(): void {
  on(IpcInvoke.ProviderUsageSnapshot, () => providerUsageSnapshotHandler());
}

async function readAdapterSnapshot(
  provider: ProviderUsageProviderId,
): Promise<ProviderUsageSnapshot> {
  const label = PROVIDER_LABELS[provider];
  const adapter = adapterRegistry.get(provider);
  if (!adapter) {
    return unavailableUsageSnapshot(provider, label, `${label} 暂时无法读取额度信息`);
  }
  if (!adapter.getUsageSnapshot) {
    return unavailableUsageSnapshot(provider, label, `${label} 暂不支持读取额度信息`);
  }
  try {
    return await adapter.getUsageSnapshot();
  } catch (err) {
    return errorUsageSnapshot(provider, label, err);
  }
}
