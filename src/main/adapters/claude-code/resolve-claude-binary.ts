import { existsSync } from 'node:fs';
import { getPathToClaudeCodeExecutable } from '@main/adapters/claude-code/sdk-runtime';
import { settingsStore } from '@main/store/settings-store';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import {
  resolveClaudeBinaryFromConfig,
  type ClaudeBinaryState,
} from './binary-resolution';

const SUMMARY_INTERVAL_MS = 300_000;

function createLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('claude-binary');
  } catch {
    return null;
  }
}

function createTracker(): BoundedLogStateTracker<
  'binary',
  ClaudeBinaryState
> | null {
  try {
    return new BoundedLogStateTracker<'binary', ClaudeBinaryState>({
      capacity: 1,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createLogger();
const tracker = createTracker();

function observeBinaryState(state: ClaudeBinaryState): void {
  if (!tracker) return;
  try {
    emitBinaryDecision(
      tracker.observe('binary', {
        signature: state,
        abnormal: state !== 'healthy',
      }),
    );
  } catch {
    // Diagnostics cannot alter override priority or fallback behavior.
  }
}

function emitBinaryDecision(decision: LogStateDecision<ClaudeBinaryState>): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<ClaudeBinaryState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'claude-configuration-state',
      runId: getProcessRunId(),
      operation: 'binary',
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

/**
 * Prefer a trimmed, existing user override. Empty or missing overrides use the bundled executable;
 * a configured path that does not exist uses the same fallback without exposing that path.
 */
export function resolveClaudeBinary(): string | undefined {
  return resolveClaudeBinaryFromConfig(settingsStore.get('claudeCliPath'), {
    pathExists: existsSync,
    bundledBinary: getPathToClaudeCodeExecutable,
    observeState: observeBinaryState,
  });
}
