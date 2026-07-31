import { IpcInvoke } from '@shared/ipc-channels';
import type {
  ProviderUsageProviderId,
  ProviderUsageSnapshot,
  ProviderUsageSnapshotResult,
  ProviderUsageStatus,
} from '@shared/types';
import { adapterRegistry } from '@main/adapters/registry';
import {
  errorUsageSnapshot,
  providerUsageLabel,
  unavailableUsageSnapshot,
} from '@main/adapters/provider-usage';
import { on } from './_helpers';
import log from '@main/utils/logger';
import { PROVIDER_USAGE_CACHE_TTL_MS } from '@shared/constants/provider-usage';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';

const logger = log.scope('provider-usage');

const PROVIDER_ORDER: ReadonlyArray<ProviderUsageProviderId> = [
  'claude-code',
  'codex-cli',
  'grok-build',
];

const PROVIDER_USAGE_READ_TIMEOUT_ERROR = '__provider_usage_read_timeout__';
export const PROVIDER_USAGE_READ_TIMEOUT_MS = 5_000;
export const PROVIDER_USAGE_SLOW_READ_MS = 2_000;
export const PROVIDER_USAGE_LOG_SUMMARY_INTERVAL_MS = 60 * 60_000;

type ProviderUsageDiagnosticState =
  | 'healthy'
  | 'slow'
  | 'timeout-cached'
  | 'timeout-empty'
  | Exclude<ProviderUsageStatus, 'ok'>;

type ProviderUsageSnapshotOptions = {
  force?: boolean;
};

type ProviderUsageInFlightFetch = {
  seq: number;
  promise: Promise<ProviderUsageSnapshotResult>;
};

type SuccessfulProviderSnapshot = {
  seq: number;
  snapshot: ProviderUsageSnapshot;
};

export { PROVIDER_USAGE_CACHE_TTL_MS };

let cachedResult: { result: ProviderUsageSnapshotResult; fetchedAt: number; seq: number } | null = null;
let normalInFlightFetch: ProviderUsageInFlightFetch | null = null;
let forceInFlightFetch: ProviderUsageInFlightFetch | null = null;
let nextFetchSeq = 0;
const lastSuccessfulSnapshots = new Map<ProviderUsageProviderId, SuccessfulProviderSnapshot>();
const latestProviderReadSeq = new Map<ProviderUsageProviderId, number>();
let providerUsageLogState = createProviderUsageLogState();

function createProviderUsageLogState(): BoundedLogStateTracker<
  ProviderUsageProviderId,
  ProviderUsageDiagnosticState
> {
  return new BoundedLogStateTracker({
    capacity: PROVIDER_ORDER.length,
    summaryIntervalMs: PROVIDER_USAGE_LOG_SUMMARY_INTERVAL_MS,
    now: () => Date.now(),
  });
}

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
  } catch {
    try {
      logger.warn(
        'provider usage prefetch failed',
        safeDiagnostic({
          event: 'provider-usage-prefetch-failed',
          runId: getProcessRunId(),
        }),
      );
    } catch {
      // Prefetch diagnostics are best-effort and must not reject startup work.
    }
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
  const initialSnapshots = await Promise.all(
    PROVIDER_ORDER.map((provider) => readAdapterSnapshot(provider, seq)),
  );
  const snapshots = initialSnapshots.map((snapshot, index) => {
    const lateSuccess = lastSuccessfulSnapshots.get(PROVIDER_ORDER[index]);
    return lateSuccess?.seq === seq ? lateSuccess.snapshot : snapshot;
  });
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
  lastSuccessfulSnapshots.clear();
  latestProviderReadSeq.clear();
  providerUsageLogState = createProviderUsageLogState();
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
  seq: number,
): Promise<ProviderUsageSnapshot> {
  const label = providerUsageLabel(provider);
  const startedAt = Date.now();
  latestProviderReadSeq.set(provider, Math.max(latestProviderReadSeq.get(provider) ?? 0, seq));
  const adapter = adapterRegistry.get(provider);
  if (!adapter) {
    const snapshot = unavailableUsageSnapshot(
      provider,
      `${label} 暂时无法读取额度信息`,
    );
    observeProviderUsage(provider, seq, snapshot.status, elapsedSince(startedAt));
    return snapshot;
  }
  if (!adapter.getUsageSnapshot) {
    const snapshot = unavailableUsageSnapshot(
      provider,
      `${label} 暂不支持读取额度信息`,
    );
    observeProviderUsage(provider, seq, snapshot.status, elapsedSince(startedAt));
    return snapshot;
  }
  let timedOut = false;
  try {
    const work = adapter.getUsageSnapshot().then((snapshot) => {
      const canonical = canonicalProviderUsageSnapshot(provider, snapshot);
      if (canonical.status === 'ok' && latestProviderReadSeq.get(provider) === seq) {
        lastSuccessfulSnapshots.set(provider, { seq, snapshot: canonical });
        replaceCachedProviderSnapshot(provider, canonical, seq);
      }
      // A late success still refreshes the cache, but the timeout remains the useful diagnostic
      // for this read. Emitting its full elapsed time as a second "slow" transition duplicates one
      // incident and obscures the bounded timeout signal.
      if (!timedOut) {
        observeProviderUsage(provider, seq, canonical.status, elapsedSince(startedAt));
      }
      return canonical;
    });
    return await raceWithTimeout({
      work,
      timeoutMs: PROVIDER_USAGE_READ_TIMEOUT_MS,
      errorMessage: PROVIDER_USAGE_READ_TIMEOUT_ERROR,
    });
  } catch (err) {
    if (err instanceof Error && err.message === PROVIDER_USAGE_READ_TIMEOUT_ERROR) {
      timedOut = true;
      const stale = lastSuccessfulSnapshots.get(provider);
      observeProviderUsage(
        provider,
        seq,
        stale ? 'timeout-cached' : 'timeout-empty',
        elapsedSince(startedAt),
      );
      return stale?.snapshot ?? unavailableUsageSnapshot(
        provider,
        `${label} 额度读取超时，已跳过本次刷新`,
      );
    }
    observeProviderUsage(provider, seq, 'error', elapsedSince(startedAt));
    return errorUsageSnapshot(provider, err);
  }
}

function canonicalProviderUsageSnapshot(
  provider: ProviderUsageProviderId,
  snapshot: ProviderUsageSnapshot,
): ProviderUsageSnapshot {
  const label = providerUsageLabel(provider);
  return snapshot.label === label ? snapshot : { ...snapshot, label };
}

function elapsedSince(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  return Number.isFinite(elapsed)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed))
    : 0;
}

function observeProviderUsage(
  provider: ProviderUsageProviderId,
  seq: number,
  outcome: ProviderUsageStatus | 'timeout-cached' | 'timeout-empty',
  durationMs: number,
): void {
  if (latestProviderReadSeq.get(provider) !== seq) return;
  try {
    const signature = providerUsageDiagnosticState(outcome, durationMs);
    const decision = providerUsageLogState.observe(provider, {
      signature,
      abnormal: signature !== 'healthy',
      metric: durationMs,
    });

    if (decision.kind === 'repeat') return;
    if (decision.kind === 'initial' && !decision.current.abnormal) return;
    if (decision.kind === 'periodic-summary') {
      writeProviderUsageDiagnostic(
        'warn',
        'provider usage state remains degraded',
        provider,
        decision,
      );
      return;
    }
    if (decision.current.abnormal) {
      writeProviderUsageDiagnostic(
        'warn',
        'provider usage state degraded',
        provider,
        decision,
      );
      return;
    }
    if (decision.flushed?.abnormal) {
      writeProviderUsageDiagnostic(
        'info',
        'provider usage state recovered',
        provider,
        decision,
      );
    }
  } catch {
    // Diagnostics must never change provider reads, cache state, or fallback behavior.
  }
}

function providerUsageDiagnosticState(
  outcome: unknown,
  durationMs: number,
): ProviderUsageDiagnosticState {
  if (outcome === 'ok') {
    return durationMs >= PROVIDER_USAGE_SLOW_READ_MS ? 'slow' : 'healthy';
  }
  // These are expected account/capability states, not operational failures. Keeping them healthy
  // also avoids persisting subscription state in diagnostics.
  if (outcome === 'not_subscribed' || outcome === 'unsupported') {
    return 'healthy';
  }
  if (
    outcome === 'error' ||
    outcome === 'unavailable' ||
    outcome === 'timeout-cached' ||
    outcome === 'timeout-empty'
  ) {
    return outcome;
  }
  return 'error';
}

function writeProviderUsageDiagnostic(
  level: 'info' | 'warn',
  message: string,
  provider: ProviderUsageProviderId,
  decision: LogStateDecision<ProviderUsageDiagnosticState>,
): void {
  const priorAbnormal: LogStateSnapshot<ProviderUsageDiagnosticState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate =
    decision.kind === 'periodic-summary'
      ? priorAbnormal ?? decision.current
      : decision.current.abnormal
        ? decision.current
        : priorAbnormal ?? decision.current;
  const suppressed = priorAbnormal ?? decision.current;
  logger[level](
    message,
    safeDiagnostic({
      event: 'provider-usage-state',
      runId: getProcessRunId(),
      provider,
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      abnormalDurationMs: aggregate.abnormalDurationMs,
      maxDurationMs: aggregate.maxMetric,
      suppressedCount: suppressed.suppressedCount,
      suppressedCountCapped: suppressed.suppressedCountCapped,
      slowThresholdMs: PROVIDER_USAGE_SLOW_READ_MS,
      timeoutMs: PROVIDER_USAGE_READ_TIMEOUT_MS,
    }),
  );
}

function replaceCachedProviderSnapshot(
  provider: ProviderUsageProviderId,
  snapshot: ProviderUsageSnapshot,
  seq: number,
): void {
  if (cachedResult?.seq !== seq) return;
  cachedResult = {
    result: {
      snapshots: cachedResult.result.snapshots.map((current) =>
        current.provider === provider ? snapshot : current,
      ),
    },
    fetchedAt: Date.now(),
    seq,
  };
}
