import { IpcInvoke } from '@shared/ipc-channels';
import type {
  ProviderUsageProviderId,
  ProviderUsageSnapshot,
  ProviderUsageSnapshotResult,
} from '@shared/types';
import { adapterRegistry } from '@main/adapters/registry';
import { errorUsageSnapshot, unavailableUsageSnapshot } from '@main/adapters/provider-usage';
import { on } from './_helpers';
import log from '@main/utils/logger';
import { PROVIDER_USAGE_CACHE_TTL_MS } from '@shared/constants/provider-usage';

const logger = log.scope('provider-usage');

const PROVIDER_ORDER: ReadonlyArray<ProviderUsageProviderId> = [
  'claude-code',
  'codex-cli',
  'grok-build',
];

const PROVIDER_LABELS: Record<ProviderUsageProviderId, string> = {
  'claude-code': 'Claude',
  'codex-cli': 'Codex',
  'grok-build': 'Grok',
};

type ProviderUsageSnapshotOptions = {
  force?: boolean;
};

type ProviderUsageInFlightFetch = {
  seq: number;
  promise: Promise<ProviderUsageSnapshotResult>;
};

export { PROVIDER_USAGE_CACHE_TTL_MS };

let cachedResult: { result: ProviderUsageSnapshotResult; fetchedAt: number; seq: number } | null = null;
let normalInFlightFetch: ProviderUsageInFlightFetch | null = null;
let forceInFlightFetch: ProviderUsageInFlightFetch | null = null;
let nextFetchSeq = 0;

export async function providerUsageSnapshotHandler(
  opts: ProviderUsageSnapshotOptions = {},
): Promise<ProviderUsageSnapshotResult> {
  const now = Date.now();
  if (opts.force) {
    if (forceInFlightFetch) return forceInFlightFetch.promise;
    return startProviderUsageFetch('force');
  }
  if (forceInFlightFetch) return forceInFlightFetch.promise;
  if (!opts.force && cachedResult && now - cachedResult.fetchedAt < PROVIDER_USAGE_CACHE_TTL_MS) {
    return cachedResult.result;
  }
  if (normalInFlightFetch) return normalInFlightFetch.promise;

  return startProviderUsageFetch('normal');
}

export async function prefetchProviderUsageSnapshots(): Promise<void> {
  try {
    await providerUsageSnapshotHandler();
  } catch (err) {
    logger.warn('[provider-usage] startup prefetch failed:', err);
  }
}

function startProviderUsageFetch(kind: 'normal' | 'force'): Promise<ProviderUsageSnapshotResult> {
  const seq = ++nextFetchSeq;
  const promise = fetchProviderUsageSnapshots(seq).finally(() => {
    if (kind === 'normal' && normalInFlightFetch?.seq === seq) normalInFlightFetch = null;
    if (kind === 'force' && forceInFlightFetch?.seq === seq) forceInFlightFetch = null;
  });
  const entry = { seq, promise };
  if (kind === 'normal') normalInFlightFetch = entry;
  else forceInFlightFetch = entry;
  return promise;
}

async function fetchProviderUsageSnapshots(seq: number): Promise<ProviderUsageSnapshotResult> {
  const snapshots = await Promise.all(PROVIDER_ORDER.map(readAdapterSnapshot));
  const result = { snapshots };
  if (!cachedResult || seq >= cachedResult.seq) {
    cachedResult = { result, fetchedAt: Date.now(), seq };
  }
  return result;
}

/** Test seam: reset IPC cache/dedupe state between isolated handler tests. */
export function _resetProviderUsageCacheForTesting(): void {
  cachedResult = null;
  normalInFlightFetch = null;
  forceInFlightFetch = null;
  nextFetchSeq = 0;
}

export function registerProviderUsageIpc(): void {
  on(IpcInvoke.ProviderUsageSnapshot, (_e, opts) =>
    providerUsageSnapshotHandler(normalizeProviderUsageSnapshotOptions(opts)),
  );
}

function normalizeProviderUsageSnapshotOptions(value: unknown): ProviderUsageSnapshotOptions {
  if (value && typeof value === 'object' && 'force' in value) {
    return { force: (value as { force?: unknown }).force === true };
  }
  return {};
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
