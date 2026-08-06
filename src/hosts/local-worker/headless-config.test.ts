import { describe, expect, it } from 'vitest';

import { parseLocalWorkerHeadlessConfig } from './headless-config';

function config() {
  const privateRoot = '/private/agent-deck/workers/worker-config-a';
  return {
    schemaVersion: 2,
    instanceId: 'instance-a',
    appVersion: '0.1.0',
    runtimeModule: '/opt/agent-deck/linux-headless/local-worker-runtime/index.mjs',
    runtimeOptions: {},
    generationFile: `${privateRoot}/generation.json`,
    ssh: {
      sshBinary: '/usr/bin/ssh',
      host: 'relay.example.test',
      port: 22,
      user: 'agentdeck',
      identityFile: `${privateRoot}/ssh/id_ed25519`,
      knownHostsFile: `${privateRoot}/ssh/known_hosts`,
      instanceId: 'instance-a',
      workerId: 'worker-a',
      credentialId: 'worker-credential-a',
      connectTimeoutSeconds: 15,
    },
    workspaceSandbox: {
      schemaVersion: 1,
      execution: 'relay-worker',
      workerConfigId: 'worker-config-a',
      workerId: 'worker-a',
      workspaceRoot: '/workspace/project',
      privateRoot,
      runtimeReadRoots: ['/opt/agent-deck', '/usr/bin', '/usr/lib'],
      environment: {
        coreConfigRoot: `${privateRoot}/core-config`,
        coreRuntimeRoot: `${privateRoot}/core-runtime`,
        coreStateRoot: `${privateRoot}/core-state`,
        providerCacheRoot: `${privateRoot}/provider-cache`,
        providerHomeRoot: `${privateRoot}/provider-home`,
        providerTempRoot: `${privateRoot}/provider-tmp`,
      },
      networkBoundary: 'provider-controlled',
    },
  };
}

describe('LocalWorkerHeadlessConfig workspace sandbox', () => {
  it('binds Worker SSH, private state, runtime, and workspace identities', () => {
    const parsed = parseLocalWorkerHeadlessConfig(config());

    expect(parsed.workspaceSandbox).toMatchObject({
      execution: 'relay-worker',
      workerConfigId: 'worker-config-a',
      workerId: 'worker-a',
    });
    expect(parsed.runtimeOptions).toEqual({});
  });

  it('rejects paths or identities that escape the Worker configuration', () => {
    expect(() => parseLocalWorkerHeadlessConfig({
      ...config(),
      generationFile: '/tmp/generation.json',
    })).toThrow('Worker private root');
    expect(() => parseLocalWorkerHeadlessConfig({
      ...config(),
      workspaceSandbox: { ...config().workspaceSandbox, workerId: 'worker-b' },
    })).toThrow('identities');
    expect(() => parseLocalWorkerHeadlessConfig({
      ...config(),
      runtimeModule: '/tmp/runtime.mjs',
    })).toThrow('runtimeModule');
  });

  it('rejects the pre-release schema without a Workspace sandbox', () => {
    const legacy = { ...config(), schemaVersion: 1 } as Record<string, unknown>;
    delete legacy.workspaceSandbox;

    expect(() => parseLocalWorkerHeadlessConfig(legacy)).toThrow('missing or extra fields');
  });
});
