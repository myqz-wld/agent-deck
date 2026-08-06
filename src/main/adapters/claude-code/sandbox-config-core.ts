import { join } from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeSandboxState = 'healthy' | 'invalid-mode';

export interface ClaudeSandboxHost {
  homeDir(): string;
  observeState(state: ClaudeSandboxState): void;
}

function observeSandboxState(host: ClaudeSandboxHost, state: ClaudeSandboxState): void {
  try {
    host.observeState(state);
  } catch {
    // Diagnostics cannot alter sandbox options or defensive fallback.
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
function buildSensitiveDenyReadPaths(home: string): string[] {
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
export function buildSandboxOptionsCore(
  mode: SandboxMode | undefined,
  cwd: string,
  host: ClaudeSandboxHost,
  extraAllowWrite?: readonly string[],
): { sandbox?: SandboxSettings } {
  if (mode === undefined || mode === 'off') {
    const result = {};
    observeSandboxState(host, 'healthy');
    return result;
  }
  if (mode !== 'workspace-write' && mode !== 'strict') {
    const result = {};
    observeSandboxState(host, 'invalid-mode');
    return result;
  }

  const home = host.homeDir();
  const sensitiveDenyRead = buildSensitiveDenyReadPaths(home);
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
    observeSandboxState(host, 'healthy');
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
  observeSandboxState(host, 'healthy');
  return result;
}
