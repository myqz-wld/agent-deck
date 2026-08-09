import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  prependResolvedCodexPathDirs,
  resolveCodexBinary,
} from '../sdk-bridge/codex-binary';
import type { CodexAppServerProcessStart } from './client-host-port';

export interface CodexAppServerProcessHostDependencies {
  spawnProcess: typeof spawn;
  resolveBinary(): string | null;
  prependPathDirs(env: Record<string, string>): void;
}

const desktopDependencies: CodexAppServerProcessHostDependencies = {
  spawnProcess: spawn,
  resolveBinary: resolveCodexBinary,
  prependPathDirs: prependResolvedCodexPathDirs,
};

export function createCodexAppServerProcessStarter(
  dependencies: CodexAppServerProcessHostDependencies = desktopDependencies,
): (input: CodexAppServerProcessStart) => ChildProcessWithoutNullStreams {
  return (input) => {
    const override = input.codexPathOverride?.trim() ?? '';
    const command = override || dependencies.resolveBinary() || 'codex';
    const env = { ...input.env };
    if (!override) dependencies.prependPathDirs(env);
    return dependencies.spawnProcess(command, ['app-server', '--stdio'], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env,
      stdio: 'pipe',
    });
  };
}

export const startDesktopCodexAppServerProcess = createCodexAppServerProcessStarter();
