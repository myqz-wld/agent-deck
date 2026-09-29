import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ deployedExpired: false, home: '', arguments: '' }));
vi.mock('node:os', async (original) => ({
  ...await original(), homedir: () => state.home,
}));
vi.mock('./process.mjs', () => ({
  runCommand: vi.fn(async (_executable, args) => {
    if (args[0] === 'check-installed-provider-credential' && state.deployedExpired) {
      throw new Error('deployed fixture credential expired');
    }
    const stdout = args[0] === 'runtime-paths'
      ? JSON.stringify({ privateRoot: '/private/fixture', stateRoot: '/private/fixture/state',
        brokerRoot: '/private/fixture/broker', supervisorRoot: '/private/fixture/supervisor',
        supervisorSocketPath: '/private/fixture/supervisor/s.sock' })
      : args[0] === 'print' ? `state = running\npid = 999\n${state.arguments}` : '';
    return { code: 0, stdout, stderr: '', timedOut: false };
  }),
}));

import { runCommand } from './process.mjs';
import { assertCredentialSyncArguments, deployWorkerProviderSupervisor,
  verifyWorkerProviderSupervisor } from './worker-supervisor.mjs';

const config = {
  command: '/opt/fixture/bin/agent-deck-provider-supervisor',
  workerWrapper: '/opt/Fixture App/bin/agent-deck-worker',
  templateFile: resolve(import.meta.dirname,
    '../../deploy/linux/provider-session/com.agentdeck.provider-supervisor.plist.in'),
  configFile: '/private/fixture/host.json',
  grokCredentialFile: '/private/fixture/native-auth.json',
  workerConfigId: `worker-${'a'.repeat(24)}`,
  hostConfig: {
    instanceId: 'credential-health-fixture', privateRoot: '/private/fixture',
    stateRoot: '/private/fixture/state', brokerRoot: '/private/fixture/broker',
    transportRuntimeDirectory: '/private/fixture/supervisor',
    transportSocketPath: '/private/fixture/supervisor/s.sock',
  },
};

function loadedArguments() {
  return `\targuments = {\n\t\t--credential-source\n\t\t${config.grokCredentialFile}\n` +
    `\t\t--worker-wrapper\n\t\t${config.workerWrapper}\n` +
    `\t\t--worker-config\n\t\t${config.workerConfigId}\n\t}\n`;
}

beforeEach(async () => {
  state.deployedExpired = false;
  state.arguments = loadedArguments();
  state.home = await realpath(await mkdtemp(join(tmpdir(), 'ad-credential-health-')));
  vi.clearAllMocks();
});
afterEach(async () => { await rm(state.home, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'darwin')('managed Worker deployed credential health', () => {
  it('rejects a loaded job without the current source and Worker binding', () => {
    expect(() => assertCredentialSyncArguments('state = running\n', config)).toThrow(/同步配置/);
    const loaded = `arguments = {\n--credential-source\n${config.grokCredentialFile}\n` +
      `--worker-wrapper\n${config.workerWrapper}\n--worker-config\n${config.workerConfigId}\n}\n`;
    expect(() => assertCredentialSyncArguments(loaded, config)).not.toThrow();
    expect(() => assertCredentialSyncArguments(loaded.replace(config.workerConfigId, 'wrong'), config))
      .toThrow(/同步配置/);
  });
  it('rejects an expired deployed copy even when source and supervisor checks succeed', async () => {
    await deployWorkerProviderSupervisor(config);
    state.deployedExpired = true;
    const result = await verifyWorkerProviderSupervisor(config);
    expect(result.components.configuration).toBe('ok');
    expect(result.components.service).toBe('running');
    expect(result.components.credential).toBe('invalid');
    expect(result.status).toBe('degraded');
  });

  it('checks the exact Worker copy separately from the native source', async () => {
    await deployWorkerProviderSupervisor(config);
    const result = await verifyWorkerProviderSupervisor(config);
    expect(result.status).toBe('running');
    expect(result.components.credential).toBe('ok');
    expect(runCommand).toHaveBeenCalledWith(config.workerWrapper, [
      'check-installed-provider-credential', '--worker', config.workerConfigId,
    ], expect.any(Object));
  });

  it('detects stale loaded arguments even when the persisted service definition is current', async () => {
    await deployWorkerProviderSupervisor(config);
    state.arguments = '';
    const result = await verifyWorkerProviderSupervisor(config);
    expect(result.components.configuration).toBe('ok');
    expect(result.components.credential).toBe('ok');
    expect(result.components.service).toBe('unavailable');
    expect(result.status).toBe('degraded');
  });
});
