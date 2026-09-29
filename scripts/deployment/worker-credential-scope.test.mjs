import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(sourceLocation) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ad-credential-scope-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const shared = join(root, 'shared');
  const bin = join(root, 'bin');
  const wrapper = join(bin, 'agent-deck-worker');
  const command = join(bin, 'agent-deck-provider-supervisor');
  const template = join(root, 'provider-session/com.agentdeck.provider-supervisor.plist.in');
  const grokCredentialFile = join(root, sourceLocation, 'auth.json');
  const configFile = join(root, 'worker.json');
  const hostConfig = join(root, 'supervisor.json');
  for (const directory of [workspace, shared, bin, dirname(template), dirname(grokCredentialFile)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  for (const executable of [wrapper, command]) {
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  await writeFile(template, '<plist/>', { mode: 0o644 });
  await writeFile(grokCredentialFile, '{}', { mode: 0o600 });
  await writeFile(hostConfig, JSON.stringify({
    schemaVersion: 1, instanceId: 'fixture', workspaceRoot: workspace,
    privateRoot: shared, stateRoot: join(shared, 'state'), brokerRoot: join(shared, 'broker'),
    transportRuntimeDirectory: join(shared, 'transport'),
    transportSocketPath: join(shared, 'transport/s.sock'),
    desktopSocketPath: join(root, 'docker.sock'), desktopVm: 'colima', engine: 'docker-desktop',
    executable: '/usr/bin/false', images: {}, maxActive: 1,
    rootlessHome: null, rootlessRuntimeDirectory: null,
  }), { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 1, name: 'fixture', wrapper, credentialFile: null, workspace,
    providerSupervisor: { command, configFile: hostConfig, grokCredentialFile,
      workerConfigId: `worker-${'b'.repeat(24)}` },
  }), { mode: 0o600 });
  return { configFile, repo: join(root, 'repo') };
}

describe('host credential source visibility boundary', () => {
  it.each(['workspace', 'shared', 'workspace/..credentials'])(
    'rejects a source in %s before deployment can change services', async (location) => {
      const { configFile, repo } = await fixture(location);
      await expect(loadWorkerConfig(configFile, repo)).rejects.toThrow(/共享运行时目录之外/);
    },
  );

  it('accepts a private source outside both Worker-visible roots', async () => {
    const { configFile, repo } = await fixture('host-auth');
    await expect(loadWorkerConfig(configFile, repo)).resolves.toMatchObject({ name: 'fixture' });
  });
});
