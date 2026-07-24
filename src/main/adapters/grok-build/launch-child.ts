import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

const LOGIN_SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh']);
const MANAGED_CHILD_ENV = {
  // In-app Grok sessions are already ACP-owned. If a user hook still reaches Agent Deck, retain
  // the same SDK-origin dedup fallback used by the Claude/Codex bridges.
  AGENT_DECK_ORIGIN: 'sdk',
  // Grok scans Claude/Cursor hooks by default. Agent Deck installs hooks for those external CLI
  // adapters, so loading them in an ACP-owned Grok child would create duplicate/ghost sessions.
  // Native Grok hooks remain enabled.
  GROK_CLAUDE_HOOKS_ENABLED: '0',
  GROK_CURSOR_HOOKS_ENABLED: '0',
} as const;

export function buildGrokChildEnv(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, ...MANAGED_CHILD_ENV };
}

export interface GrokLaunchSpec {
  command: string;
  args: string[];
  useLoginShell: boolean;
}

/**
 * Use the user's login shell only for the real Grok child. This lets a GUI-launched app pass
 * exported API-key variables to Grok without reading, persisting, or logging their values.
 */
export function buildGrokLaunchSpec(
  binary: string,
  args: string[],
  options: {
    platform?: NodeJS.Platform;
    shell?: string;
    explicitTestArgs?: boolean;
  } = {},
): GrokLaunchSpec {
  const platform = options.platform ?? process.platform;
  if (options.explicitTestArgs || platform === 'win32') {
    return { command: binary, args, useLoginShell: false };
  }

  const shell =
    options.shell ??
    process.env.SHELL ??
    (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  if (!LOGIN_SHELLS.has(basename(shell))) {
    return { command: binary, args, useLoginShell: false };
  }

  return {
    command: shell,
    // $0 is a fixed label; binary and every Grok argument remain positional argv values.
    // The export runs after login-shell startup files, so they cannot accidentally re-enable
    // cross-adapter hook scanners. fd 3 keeps ACP stdout separate from shell startup text.
    args: [
      '-ilc',
      'export AGENT_DECK_ORIGIN=sdk GROK_CLAUDE_HOOKS_ENABLED=0 GROK_CURSOR_HOOKS_ENABLED=0; exec "$@" 1>&3',
      'agent-deck-grok',
      binary,
      ...args,
    ],
    useLoginShell: true,
  };
}

export function spawnGrokChild(options: {
  binary: string;
  args?: string[];
  cwd: string;
}): {
  child: ChildProcessWithoutNullStreams;
  protocolOutput: Readable;
  startupOutput: Readable | null;
  usedLoginShell: boolean;
} {
  const grokArgs = options.args ?? ['agent', '--no-leader', 'stdio'];
  const spec = buildGrokLaunchSpec(options.binary, grokArgs, {
    explicitTestArgs: options.args !== undefined,
  });

  if (!spec.useLoginShell) {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: buildGrokChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      child,
      protocolOutput: child.stdout,
      startupOutput: null,
      usedLoginShell: false,
    };
  }

  const child = spawn(spec.command, spec.args, {
    cwd: options.cwd,
    env: buildGrokChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const protocolOutput = child.stdio[3] as Readable | null;
  if (!protocolOutput) {
    child.kill('SIGTERM');
    throw new Error('Unable to create the dedicated Grok ACP output pipe.');
  }
  return {
    child,
    protocolOutput,
    startupOutput: child.stdout,
    usedLoginShell: true,
  };
}
