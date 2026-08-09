import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerCoreRuntimeFactoryInput } from './root';
import {
  resolveServerCoreProviderContainerRuntimePaths,
  resolveServerCoreProviderGrokContainer,
  validateServerCoreProviderContainerOption,
} from './runtime-provider-container';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function input(runtimeOptions: ServerCoreRuntimeFactoryInput['runtimeOptions']) {
  const root = realpathSync(mkdtempSync('/tmp/ad-provider-core-'));
  roots.push(root);
  return {
    appVersion: '1.0.0',
    instanceId: 'instance-a',
    paths: {
      configurationDirectory: join(root, 'config'),
      instanceId: 'instance-a',
      logDirectory: join(root, 'state', 'logs'),
      runtimeDirectory: join(root, 'run', 'instance-a'),
      socketPath: join(root, 'run', 'instance-a', 'agent-deckd.sock'),
      stateDirectory: join(root, 'state'),
    },
    runtimeOptions,
  } satisfies ServerCoreRuntimeFactoryInput;
}

const diagnostics = () => ({ info: vi.fn(), warn: vi.fn() });

describe('Server Core production Provider container resolver', () => {
  it('uses one exact version marker and a stable short private socket namespace', () => {
    expect(validateServerCoreProviderContainerOption({})).toBe(false);
    expect(validateServerCoreProviderContainerOption({
      providerContainer: { schemaVersion: 1 },
    })).toBe(true);
    for (const invalid of [
      null,
      { schemaVersion: 2 },
      { schemaVersion: 1, engineSocket: '/run/podman.sock' },
    ] as const) {
      expect(() => validateServerCoreProviderContainerOption({
        providerContainer: invalid as never,
      })).toThrow();
    }
    const paths = resolveServerCoreProviderContainerRuntimePaths(input({}));
    expect(paths.supervisorSocketPath).toMatch(/\.provider-[a-f0-9]{16}\/supervisor\/s\.sock$/);
    expect(Buffer.byteLength(paths.supervisorSocketPath)).toBeLessThanOrEqual(103);
  });

  it('keeps a deeply installed macOS Relay Worker inside the Unix-socket bound', () => {
    const configured = input({ providerContainer: { schemaVersion: 1 } });
    const privateRoot = '/Users/agent/Library/Containers/com.agentdeck.worker-sandbox/Data/' +
      'Library/Application Support/Agent Deck/workers/worker-config-a';
    const paths = resolveServerCoreProviderContainerRuntimePaths(configured, {
      schemaVersion: 1,
      execution: 'relay-worker',
      workerConfigId: 'worker-config-a',
      workerId: 'worker-a',
      workspaceRoot: '/workspaces',
      privateRoot,
      runtimeReadRoots: ['/opt/agent-deck'],
      environment: {
        coreConfigRoot: `${privateRoot}/core-config`,
        coreRuntimeRoot: `${privateRoot}/core-runtime`,
        coreStateRoot: `${privateRoot}/core-state`,
        providerCacheRoot: `${privateRoot}/provider-cache`,
        providerHomeRoot: `${privateRoot}/provider-home`,
        providerTempRoot: `${privateRoot}/provider-tmp`,
      },
      networkBoundary: 'provider-controlled',
    }, { currentUid: () => 501, platform: 'darwin' });
    expect(paths.privateRoot).toBe('/private/tmp/adp-501-e5390e564047df54');
    expect(Buffer.byteLength(paths.supervisorSocketPath)).toBeLessThanOrEqual(103);
  });

  it('composes only the fixed Core view and leaves OCI authority outside Core', () => {
    const configured = input({ providerContainer: { schemaVersion: 1 } });
    const createContainer = vi.fn(() => ({
      close: async () => undefined,
      processFactory: vi.fn(),
      readiness: async () => ({
        available: true,
        disabledReason: null,
        supervisorGeneration: 1,
      }),
    }));
    expect(resolveServerCoreProviderGrokContainer(
      configured,
      '/workspaces',
      diagnostics(),
      { createContainer, credentialRoot: join(roots.at(-1)!, 'credentials') },
    )).not.toBeNull();
    expect(createContainer).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'instance-a',
      workspaceRoot: '/workspaces',
    }));
    expect(JSON.stringify(createContainer.mock.calls)).not.toMatch(
      /docker\.sock|podman\.sock|image|mount|reusableToken/i,
    );
  });

  it('keeps Claude and Codex composable when the production boundary is absent', () => {
    const warnings = diagnostics();
    const result = resolveServerCoreProviderGrokContainer(
      input({ providerContainer: { schemaVersion: 1 } }),
      '/workspaces',
      warnings,
      { createContainer: () => { throw new Error('runtime missing'); } },
    );
    expect(result).toBeNull();
    expect(warnings.warn).toHaveBeenCalledOnce();
    expect(resolveServerCoreProviderGrokContainer(input({}), '/workspaces', warnings)).toBeNull();
  });
});
