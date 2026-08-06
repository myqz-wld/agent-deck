import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import type { ClaudeSettingsEnvHost, ClaudeSettingsEnvState } from './settings-env-core';

const SUMMARY_INTERVAL_MS = 300_000;

function createLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('claude-settings-env');
  } catch {
    return null;
  }
}

function createTracker(): BoundedLogStateTracker<'settings-env', ClaudeSettingsEnvState> | null {
  try {
    return new BoundedLogStateTracker<'settings-env', ClaudeSettingsEnvState>({
      capacity: 1,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createLogger();
const tracker = createTracker();

function emitSettingsEnvDecision(
  decision: LogStateDecision<ClaudeSettingsEnvState>,
  appliedCount: number,
  rejectedCount: number,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<ClaudeSettingsEnvState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'claude-configuration-state',
      runId: getProcessRunId(),
      operation: 'settings-env',
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      abnormalDuration: aggregate.abnormalDurationMs,
      suppressedCount: aggregate.suppressedCount,
      capped: aggregate.suppressedCountCapped,
      summaryInterval: SUMMARY_INTERVAL_MS,
      appliedCount,
      rejectedCount,
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

export const desktopClaudeSettingsEnvHost: ClaudeSettingsEnvHost = {
  resolveSettingsPath: () => join(homedir(), '.claude', 'settings.json'),
  settingsFileExists: (path) => existsSync(path),
  readSettingsText: (path) => readFileSync(path, 'utf8'),
  assignEnv: (key, value) => {
    process.env[key] = value;
  },
  observeState: (state, appliedCount, rejectedCount) => {
    if (!tracker) return;
    try {
      emitSettingsEnvDecision(tracker.observe('settings-env', {
        signature: state,
        abnormal: state !== 'healthy',
      }), appliedCount, rejectedCount);
    } catch {
      // Diagnostics cannot alter environment assignments or the existing fallback.
    }
  },
};
