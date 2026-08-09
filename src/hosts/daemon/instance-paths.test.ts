import { describe, expect, it } from 'vitest';

import {
  assertInstanceId,
  DaemonPathError,
  resolveDaemonInstancePaths,
  type DaemonPathEnvironment,
} from './instance-paths';

const environment = {
  HOME: '/srv/agent-deck',
  XDG_CONFIG_HOME: '/srv/agent-deck/config',
  XDG_RUNTIME_DIR: '/run/user/1200',
  XDG_STATE_HOME: '/srv/agent-deck/state',
};

describe('daemon instance paths', () => {
  it('derives an isolated namespace from normalized XDG roots', () => {
    expect(resolveDaemonInstancePaths('tenant-1', environment)).toEqual({
      instanceId: 'tenant-1',
      stateDirectory: '/srv/agent-deck/state/agent-deck/instances/tenant-1',
      configurationDirectory: '/srv/agent-deck/config/agent-deck/instances/tenant-1',
      logDirectory: '/srv/agent-deck/state/agent-deck/instances/tenant-1/logs',
      runtimeDirectory: '/run/user/1200/agent-deck/tenant-1',
      socketPath: '/run/user/1200/agent-deck/tenant-1/agent-deckd.sock',
    });
  });

  it.each([
    '',
    '.',
    '..',
    '../tenant',
    'tenant/other',
    'tenant\\other',
    '-tenant',
    'tenant-',
    'TENANT',
    'a'.repeat(64),
  ])('rejects unsafe instance id %j', (instanceId) => {
    expect(() => assertInstanceId(instanceId)).toThrow(DaemonPathError);
  });

  it('fails closed for relative, non-normalized, root, or missing XDG runtime paths', () => {
    expect(() =>
      resolveDaemonInstancePaths('tenant', { ...environment, XDG_STATE_HOME: 'relative' }),
    ).toThrow(/XDG_STATE_HOME must be an absolute path/);
    expect(() =>
      resolveDaemonInstancePaths('tenant', {
        ...environment,
        XDG_CONFIG_HOME: '/srv/agent-deck/../config',
      }),
    ).toThrow(/must be normalized/);
    expect(() =>
      resolveDaemonInstancePaths('tenant', { ...environment, XDG_RUNTIME_DIR: '/' }),
    ).toThrow(/cannot be the filesystem root/);
    expect(() =>
      resolveDaemonInstancePaths('tenant', { ...environment, XDG_RUNTIME_DIR: undefined }),
    ).toThrow(/XDG_RUNTIME_DIR is required/);
  });

  it('rejects an actual NUL character in every filesystem root', () => {
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_RUNTIME_DIR',
      'XDG_STATE_HOME',
    ] as const) {
      const nulValue = `/srv/agent-deck/${key.toLowerCase()}\0suffix`;
      const nulEnvironment: DaemonPathEnvironment =
        key === 'HOME'
          ? {
              ...environment,
              HOME: nulValue,
              XDG_CONFIG_HOME: undefined,
              XDG_STATE_HOME: undefined,
            }
          : { ...environment, [key]: nulValue };
      expect(() =>
        resolveDaemonInstancePaths('tenant', nulEnvironment),
      ).toThrow(/must be an absolute path/);
    }
  });

  it('rejects Unix socket paths that exceed the portable private-socket bound', () => {
    expect(() =>
      resolveDaemonInstancePaths('tenant', {
        ...environment,
        XDG_RUNTIME_DIR: `/run/${'x'.repeat(100)}`,
      }),
    ).toThrow(/Unix socket path exceeds/);
  });

  it('allows a long runtime namespace only when daemon ingress is explicitly unused', () => {
    const longEnvironment = {
      ...environment,
      XDG_RUNTIME_DIR: `/private/${'worker-private-root-'.repeat(8)}`,
    };
    const paths = resolveDaemonInstancePaths(
      'tenant',
      longEnvironment,
      { controlSocket: 'unused' },
    );
    expect(paths.runtimeDirectory).toBe(`${longEnvironment.XDG_RUNTIME_DIR}/agent-deck/tenant`);
    expect(Buffer.byteLength(paths.socketPath)).toBeGreaterThan(103);
  });
});
