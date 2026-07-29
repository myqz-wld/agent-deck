import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';

const SUMMARY_INTERVAL_MS = 300_000;
type SandboxState = 'healthy' | 'invalid-mode';

function createLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('claude-sandbox');
  } catch {
    return null;
  }
}

function createTracker(): BoundedLogStateTracker<'sandbox', SandboxState> | null {
  try {
    return new BoundedLogStateTracker<'sandbox', SandboxState>({
      capacity: 1,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createLogger();
const tracker = createTracker();

function observeSandboxState(state: SandboxState): void {
  if (!tracker) return;
  try {
    emitSandboxDecision(
      tracker.observe('sandbox', {
        signature: state,
        abnormal: state !== 'healthy',
      }),
    );
  } catch {
    // Diagnostics cannot alter sandbox options or defensive fallback.
  }
}

function emitSandboxDecision(decision: LogStateDecision<SandboxState>): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<SandboxState> | null =
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

export type SandboxMode = 'off' | 'workspace-write' | 'strict';

export const SANDBOX_MODE_VALUES: ReadonlyArray<SandboxMode> = [
  'off',
  'workspace-write',
  'strict',
];

/**
 * These development tools run outside the OS sandbox when sandboxing is enabled. General-purpose
 * runtimes and system package managers stay excluded from this list to avoid broad escape paths.
 */
export const SANDBOX_EXCLUDED_COMMANDS: readonly string[] = [
  'git',
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'cargo',
  'go',
  'docker',
  'watchman',
  'orb',
  'lima',
  'colima',
  'make',
  'xcodebuild',
];

/** Both enabled modes deny reads from credential stores and shell-history locations. */
function buildSensitiveDenyReadPaths(): string[] {
  const home = homedir();
  return [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.config'),
    join(home, '.kube'),
    join(home, '.npmrc'),
    join(home, '.netrc'),
    join(home, '.pypirc'),
    join(home, '.gnupg'),
    join(home, '.docker'),
    join(home, '.zsh_history'),
    join(home, '.bash_history'),
    join(home, 'Library', 'Keychains'),
    join(home, 'Library', 'Cookies'),
  ];
}

/**
 * Convert the stored mode to the top-level SDK sandbox option. Workspace mode retains the model's
 * approved unsandboxed retry path; strict mode is read-only and disables that escape.
 */
export function buildSandboxOptions(
  mode: SandboxMode | undefined,
  cwd: string,
  extraAllowWrite?: readonly string[],
): { sandbox?: SandboxSettings } {
  if (mode === undefined || mode === 'off') {
    const result = {};
    observeSandboxState('healthy');
    return result;
  }
  if (mode !== 'workspace-write' && mode !== 'strict') {
    const result = {};
    observeSandboxState('invalid-mode');
    return result;
  }

  const sensitiveDenyRead = buildSensitiveDenyReadPaths();
  const home = homedir();
  const dedupedExtra = extraAllowWrite
    ? Array.from(new Set(extraAllowWrite.filter((path) => path !== cwd && path.length > 0)))
    : [];

  if (mode === 'workspace-write') {
    const result = {
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        excludedCommands: [...SANDBOX_EXCLUDED_COMMANDS],
        filesystem: {
          allowWrite: [cwd, ...dedupedExtra, '/tmp', join(home, '.cache', 'claude-code')],
          denyRead: sensitiveDenyRead,
        },
      },
    };
    observeSandboxState('healthy');
    return result;
  }

  const result = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [...SANDBOX_EXCLUDED_COMMANDS],
      filesystem: {
        denyRead: sensitiveDenyRead,
      },
    },
  };
  observeSandboxState('healthy');
  return result;
}
