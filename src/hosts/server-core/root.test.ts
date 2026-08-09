import { describe, expect, it, vi } from 'vitest';

import type { AuthoritativeSessionConsolePort } from '@core/session-console';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type {
  DaemonCoreRuntime,
  DaemonCredentialLifecyclePort,
  DaemonInstancePaths,
} from '@hosts/daemon';

import type { ServerCoreConfig } from './config';
import { createServerCoreController } from './root';

const paths: DaemonInstancePaths = {
  instanceId: 'instance-a',
  stateDirectory: '/srv/agent-deck/state/instance-a',
  configurationDirectory: '/srv/agent-deck/config/instance-a',
  logDirectory: '/srv/agent-deck/state/instance-a/logs',
  runtimeDirectory: '/run/agent-deck/instance-a',
  socketPath: '/run/agent-deck/instance-a/agent-deckd.sock',
};

const config: ServerCoreConfig = {
  schemaVersion: 1,
  instanceId: 'instance-a',
  appVersion: '0.1.0',
  runtimeModule: '/opt/agent-deck/runtime/server-core.mjs',
  runtimeOptions: {},
  socketPath: paths.socketPath,
};

function authority(): AuthoritativeSessionConsolePort {
  return {
    listSessions: () => ({ sessions: [], nextCursor: null, total: 0, revision: 1 }),
    getSession: () => ({ session: null, revision: 1 }),
    listProjects: () => ({ projects: [], nextCursor: null, total: 0, revision: 1 }),
    resolveProject: () => ({ project: null, revision: 1 }),
    getCapabilities: () => sessionConsoleCapabilitiesFixture(),
    listWorkspaceDirectories: ({ directory }) => ({
      directory, directories: [], truncated: false, revision: 1,
    }),
    createSession: () => ({ sessionId: 'session-a', revision: 2 }),
  };
}

function credentialLifecycle(overrides: Partial<DaemonCredentialLifecyclePort> = {}) {
  return {
    isActive: vi.fn(() => true),
    subscribeRevocations: vi.fn(() => ({ close: vi.fn(() => undefined) })),
    ...overrides,
  } satisfies DaemonCredentialLifecyclePort;
}

describe('Server Core headless root', () => {
  it('composes injected Core authority before the private authenticated ingress', async () => {
    const runtime: DaemonCoreRuntime = {
      supportedMethods: ['system.health'],
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      currentRevision: () => 1,
      execute: vi.fn(async () => ({ result: null, revision: 1 })),
    };
    const closeRevocations = vi.fn(() => undefined);
    const credentials = credentialLifecycle({
      subscribeRevocations: vi.fn(() => ({ close: closeRevocations })),
    });
    const factory = vi.fn(() => ({
      processId: 'server-core-process-a',
      runtime,
      sessionConsoleAuthority: authority(),
      credentialLifecycle: credentials,
      components: [{ name: 'injected-core-adapter', start: async () => undefined, stop: async () => undefined }],
    }));
    const controller = await createServerCoreController(config, {
      paths,
      loadModule: async () => ({ createServerCoreRuntime: factory }),
      sqlitePreflight: () => undefined,
    });

    expect(controller.composition).toMatchObject({
      topology: 'server-core',
      role: 'server-core-host',
    });
    expect(controller.composition.components.map((component) => component.name)).toEqual([
      'server-core-daemon',
      'injected-core-adapter',
      'server-core-ssh-bridge',
    ]);
    expect(factory).toHaveBeenCalledWith({
      instanceId: 'instance-a',
      appVersion: '0.1.0',
      paths,
      runtimeOptions: {},
    });
    await controller.composition.components[0]?.start();
    expect(credentials.subscribeRevocations).toHaveBeenCalledOnce();
    await controller.composition.components[0]?.stop('test-complete');
    expect(closeRevocations).toHaveBeenCalledOnce();
  });

  it('fails closed when the external runtime omits live credential lifecycle', async () => {
    await expect(createServerCoreController(config, {
      paths,
      loadModule: async () => ({
        createServerCoreRuntime: () => ({
          processId: 'server-core-process-a',
          runtime: {
            supportedMethods: ['system.health'],
            start: async () => undefined,
            stop: async () => undefined,
            currentRevision: () => 0,
            execute: async () => ({ result: null, revision: 0 }),
          },
          sessionConsoleAuthority: authority(),
        }),
      }),
    })).rejects.toThrow('bootstrap is incomplete');
  });

  it('rejects a socket namespace mismatch before loading runtime code', async () => {
    const loadModule = vi.fn();
    await expect(createServerCoreController(config, {
      paths: { ...paths, socketPath: '/run/agent-deck/other/agent-deckd.sock' },
      loadModule,
    })).rejects.toThrow('exact instance namespace');
    expect(loadModule).not.toHaveBeenCalled();
  });
});
