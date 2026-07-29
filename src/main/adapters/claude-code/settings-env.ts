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

const SUMMARY_INTERVAL_MS = 300_000;
const MAX_DIAGNOSTIC_COUNT = 10_000;
type SettingsEnvState = 'healthy' | 'rejected-keys' | 'read-failed';

function createLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('claude-settings-env');
  } catch {
    return null;
  }
}

function createTracker(): BoundedLogStateTracker<
  'settings-env',
  SettingsEnvState
> | null {
  try {
    return new BoundedLogStateTracker<'settings-env', SettingsEnvState>({
      capacity: 1,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createLogger();
const tracker = createTracker();

function observeSettingsEnvState(
  state: SettingsEnvState,
  appliedCount: number,
  rejectedCount: number,
): void {
  if (!tracker) return;
  try {
    emitSettingsEnvDecision(
      tracker.observe('settings-env', {
        signature: state,
        abnormal: state !== 'healthy',
      }),
      appliedCount,
      rejectedCount,
    );
  } catch {
    // Diagnostics cannot alter environment assignments or the existing fallback.
  }
}

function emitSettingsEnvDecision(
  decision: LogStateDecision<SettingsEnvState>,
  appliedCount: number,
  rejectedCount: number,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<SettingsEnvState> | null =
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
      appliedCount: boundedCount(appliedCount),
      rejectedCount: boundedCount(rejectedCount),
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

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_DIAGNOSTIC_COUNT, Math.floor(value));
}

const ALLOWED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];
const ALLOWED_KEYS = new Set<string>([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
]);

function isAllowed(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return true;
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function readEnvObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const env = (value as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  return env as Record<string, unknown>;
}

/**
 * Apply the allowlisted environment from the user settings file in source order. Unknown keys are
 * skipped, non-string values are ignored, and read or assignment failures retain the existing
 * best-effort return behavior.
 */
export function applyClaudeSettingsEnv(): void {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    observeSettingsEnvState('healthy', 0, 0);
    return;
  }

  let appliedCount = 0;
  let rejectedCount = 0;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const env = readEnvObject(JSON.parse(raw));
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') continue;
        if (!isAllowed(key)) {
          rejectedCount += 1;
          continue;
        }
        process.env[key] = value;
        appliedCount += 1;
      }
    }
    observeSettingsEnvState(
      rejectedCount > 0 ? 'rejected-keys' : 'healthy',
      appliedCount,
      rejectedCount,
    );
  } catch {
    observeSettingsEnvState('read-failed', appliedCount, rejectedCount);
  }
}
