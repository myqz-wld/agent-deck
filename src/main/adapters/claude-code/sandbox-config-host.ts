import { homedir } from 'node:os';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import type { ClaudeSandboxHost, ClaudeSandboxState } from './sandbox-config-core';

const SUMMARY_INTERVAL_MS = 300_000;

function createLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('claude-sandbox');
  } catch {
    return null;
  }
}

function createTracker(): BoundedLogStateTracker<'sandbox', ClaudeSandboxState> | null {
  try {
    return new BoundedLogStateTracker<'sandbox', ClaudeSandboxState>({
      capacity: 1,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createLogger();
const tracker = createTracker();

function emitSandboxDecision(decision: LogStateDecision<ClaudeSandboxState>): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<ClaudeSandboxState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'claude-configuration-state',
      runId: getProcessRunId(),
      operation: 'sandbox',
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      abnormalDuration: aggregate.abnormalDurationMs,
      suppressedCount: aggregate.suppressedCount,
      capped: aggregate.suppressedCountCapped,
      summaryInterval: SUMMARY_INTERVAL_MS,
    });
    if (decision.current.abnormal) {
      logger?.warn(
        decision.kind === 'periodic-summary'
          ? 'Claude configuration state remains degraded'
          : 'Claude configuration state degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger?.info('Claude configuration state recovered', details);
    }
  } catch {
    // Run identity, serialization, and sinks are best-effort.
  }
}

export const desktopClaudeSandboxHost: ClaudeSandboxHost = {
  homeDir: () => homedir(),
  observeState: (state) => {
    if (!tracker) return;
    try {
      emitSandboxDecision(tracker.observe('sandbox', {
        signature: state,
        abnormal: state !== 'healthy',
      }));
    } catch {
      // Diagnostics cannot alter sandbox options or defensive fallback.
    }
  },
};
