import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

const LOGIN_SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh']);

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
    // fd 3 keeps ACP stdout separate from any text printed by shell startup files.
    args: ['-ilc', 'exec "$@" 1>&3', 'agent-deck-grok', binary, ...args],
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
      env: process.env,
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
    env: process.env,
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
