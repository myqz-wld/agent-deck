import type { ClaudeCodeAdapter } from './claude-code';
import type { CodexCliAdapter } from './codex-cli';
import type { GrokBuildAdapter } from './grok-build';
import type { CreateSessionOptionsByAdapter } from './options-builder';
import type { AgentAdapter, AdapterContext } from './types';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';

const TRACKER_CAPACITY = 2;
const SUMMARY_INTERVAL_MS = 300_000;
const INIT_SLOW_THRESHOLD_MS = 10_000;
const SHUTDOWN_SLOW_THRESHOLD_MS = 5_000;
const MAX_DIAGNOSTIC_COUNT = 10_000;
const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;

type RegistryOperation = 'init' | 'shutdown';
type RegistryState = 'healthy' | 'slow' | 'partial-failure' | 'failed';

const THRESHOLD_BY_OPERATION: Record<RegistryOperation, number> = {
  init: INIT_SLOW_THRESHOLD_MS,
  shutdown: SHUTDOWN_SLOW_THRESHOLD_MS,
};

function createLogger() {
  try {
    return log.scope('adapter-registry');
  } catch {
    return null;
  }
}

const logger = createLogger();

/**
 * Compile-time adapter ids map to their concrete implementations. Dynamic callers use the
 * string-based registry API, while callers needing adapter-specific methods import that adapter.
 */
export type AdapterIdMap = {
  'claude-code': ClaudeCodeAdapter;
  'codex-cli': CodexCliAdapter;
  'grok-build': GrokBuildAdapter;
};

/** Each result preserves the registered id and the exact thrown value for its caller. */
export interface AdapterInitResult {
  id: string;
  ok: boolean;
  err?: unknown;
}

export interface AdapterShutdownResult {
  id: string;
  ok: boolean;
  err?: unknown;
}

/** Adapter ids and create-session option ids must remain identical. */
type _AssertSameKeys<A, B> = keyof A extends keyof B
  ? keyof B extends keyof A
    ? true
    : false
  : false;
const _assertAdapterIdMapMatchesOptions: _AssertSameKeys<
  AdapterIdMap,
  CreateSessionOptionsByAdapter
> = true;
void _assertAdapterIdMapMatchesOptions;

class RegistryDiagnostics {
  private readonly tracker = createTracker();

  begin(): number | null {
    return readClock();
  }

  observe(
    phase: RegistryOperation,
    totalCount: number,
    failedCount: number,
    startedAtMs: number | null,
  ): void {
    try {
      if (!this.tracker) return;
      const durationMs = elapsedSince(startedAtMs);
      const thresholdMs = THRESHOLD_BY_OPERATION[phase];
      const state = classifyState(
        totalCount,
        failedCount,
        durationMs,
        thresholdMs,
      );
      const decision = this.tracker.observe(phase, {
        signature: state,
        abnormal: state !== 'healthy',
        metric: durationMs,
      });
      emitDecision(
        decision,
        phase,
        durationMs,
        thresholdMs,
        totalCount,
        failedCount,
      );
    } catch {
      // Diagnostics cannot change adapter results or execution order.
    }
  }
}

function createTracker(): BoundedLogStateTracker<
  RegistryOperation,
  RegistryState
> | null {
  try {
    return new BoundedLogStateTracker({
      capacity: TRACKER_CAPACITY,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
      now: () => Date.now(),
    });
  } catch {
    return null;
  }
}

function readClock(): number | null {
  try {
    const value = Date.now();
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.min(MAX_NUMERIC_VALUE, value);
  } catch {
    return null;
  }
}

function elapsedSince(startedAtMs: number | null): number | null {
  const endedAtMs = readClock();
  if (
    startedAtMs === null ||
    endedAtMs === null ||
    endedAtMs < startedAtMs
  ) {
    return null;
  }
  return Math.min(MAX_NUMERIC_VALUE, endedAtMs - startedAtMs);
}

function classifyState(
  totalCount: number,
  failedCount: number,
  durationMs: number | null,
  thresholdMs: number,
): RegistryState {
  if (totalCount === 0) return 'healthy';
  if (failedCount >= totalCount) return 'failed';
  if (failedCount > 0) return 'partial-failure';
  if (durationMs !== null && durationMs >= thresholdMs) return 'slow';
  return 'healthy';
}

function emitDecision(
  decision: LogStateDecision<RegistryState>,
  phase: RegistryOperation,
  durationMs: number | null,
  thresholdMs: number,
  totalCount: number,
  failedCount: number,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<RegistryState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  if (!decision.current.abnormal && !priorAbnormal) return;
  const aggregate =
    decision.kind === 'periodic-summary'
      ? priorAbnormal ?? decision.current
      : decision.current.abnormal
        ? decision.current
        : priorAbnormal ?? decision.current;
  const suppressed = priorAbnormal ?? decision.current;

  try {
    const details = safeDiagnostic({
      event: 'adapter-registry-state',
      runId: getProcessRunId(),
      phase,
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      durationMs,
      abnormalDuration: aggregate.abnormalDurationMs,
      maxDuration: aggregate.maxMetric,
      thresholdMs,
      suppressedCount: suppressed.suppressedCount,
      capped: suppressed.suppressedCountCapped,
      summaryInterval: SUMMARY_INTERVAL_MS,
      totalCount: boundedCount(totalCount),
      failedCount: boundedCount(failedCount),
    });

    if (decision.current.abnormal) {
      logger?.warn(
        decision.kind === 'periodic-summary'
          ? 'adapter registry phase remains degraded'
          : 'adapter registry phase degraded',
        details,
      );
    } else {
      logger?.info('adapter registry phase recovered', details);
    }
  } catch {
    // Serialization, run identity, and sinks are all best-effort.
  }
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_DIAGNOSTIC_COUNT, Math.floor(value));
}

export class AdapterRegistryClass {
  private readonly map = new Map<string, AgentAdapter>();
  private readonly diagnostics = new RegistryDiagnostics();

  register(adapter: AgentAdapter): void {
    if (this.map.has(adapter.id)) {
      throw new Error(`Adapter ${adapter.id} already registered`);
    }
    this.map.set(adapter.id, adapter);
  }

  /**
   * The string API is the dynamic-dispatch boundary. Adapter-specific callers import the typed
   * adapter instance directly so union arguments do not widen create-session option types.
   */
  get(id: string): AgentAdapter | undefined {
    return this.map.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.map.values()];
  }

  async initAll(ctx: AdapterContext): Promise<AdapterInitResult[]> {
    const startedAtMs = this.diagnostics.begin();
    const results: AdapterInitResult[] = [];
    let failedCount = 0;
    for (const adapter of this.map.values()) {
      try {
        await adapter.init(ctx);
        results.push({ id: adapter.id, ok: true });
      } catch (err) {
        // A failed adapter does not prevent later adapters from initializing.
        failedCount += 1;
        results.push({ id: adapter.id, ok: false, err });
      }
    }
    this.diagnostics.observe(
      'init',
      results.length,
      failedCount,
      startedAtMs,
    );
    return results;
  }

  async shutdownAll(): Promise<AdapterShutdownResult[]> {
    const startedAtMs = this.diagnostics.begin();
    const results: AdapterShutdownResult[] = [];
    let failedCount = 0;
    for (const adapter of this.map.values()) {
      try {
        await adapter.shutdown();
        results.push({ id: adapter.id, ok: true });
      } catch (err) {
        // Every registered adapter receives its shutdown attempt in insertion order.
        failedCount += 1;
        results.push({ id: adapter.id, ok: false, err });
      }
    }
    this.diagnostics.observe(
      'shutdown',
      results.length,
      failedCount,
      startedAtMs,
    );
    return results;
  }
}

export const adapterRegistry = new AdapterRegistryClass();
