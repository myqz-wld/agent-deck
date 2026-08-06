import { describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createCodexAppServerProcessStarter,
  type CodexAppServerProcessHostDependencies,
} from './client-process-host';

function setup(binary: string | null = '/bundled/codex') {
  const child = {} as ChildProcessWithoutNullStreams;
  const spawnProcess = vi.fn((
    _command: string,
    _args: readonly string[],
    _options: Record<string, unknown>,
  ) => child);
  const resolveBinary = vi.fn(() => binary);
  const prependPathDirs = vi.fn((env: Record<string, string>) => {
    env.PATH = `/bundled/helpers:${env.PATH ?? ''}`;
  });
  const dependencies: CodexAppServerProcessHostDependencies = {
    spawnProcess: spawnProcess as unknown as CodexAppServerProcessHostDependencies['spawnProcess'],
    resolveBinary,
    prependPathDirs,
  };
  return {
    child,
    spawnProcess,
    resolveBinary,
    prependPathDirs,
    start: createCodexAppServerProcessStarter(dependencies),
  };
}

describe('Codex app-server desktop process host', () => {
  it('uses a trimmed explicit executable without resolving or mutating helper PATH', () => {
    const host = setup();
    const env = { PATH: '/usr/bin', KEEP: 'value' };

    expect(host.start({ codexPathOverride: '  /custom/codex  ', cwd: '/repo', env }))
      .toBe(host.child);

    expect(host.resolveBinary).not.toHaveBeenCalled();
    expect(host.prependPathDirs).not.toHaveBeenCalled();
    expect(host.spawnProcess).toHaveBeenCalledWith(
      '/custom/codex',
      ['app-server', '--stdio'],
      { cwd: '/repo', env, stdio: 'pipe' },
    );
    expect(env).toEqual({ PATH: '/usr/bin', KEEP: 'value' });
  });

  it('resolves the packaged executable and prepends helpers in a private env copy', () => {
    const host = setup();
    const env = { PATH: '/usr/bin' };

    host.start({ codexPathOverride: ' ', env });

    expect(host.resolveBinary).toHaveBeenCalledOnce();
    expect(host.prependPathDirs).toHaveBeenCalledOnce();
    const options = host.spawnProcess.mock.calls[0][2];
    expect(options).toEqual({ env: { PATH: '/bundled/helpers:/usr/bin' }, stdio: 'pipe' });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('falls back to the PATH command when no packaged executable resolves', () => {
    const host = setup(null);

    host.start({ env: {} });

    expect(host.spawnProcess).toHaveBeenCalledWith(
      'codex',
      ['app-server', '--stdio'],
      { env: { PATH: '/bundled/helpers:' }, stdio: 'pipe' },
    );
  });
});
