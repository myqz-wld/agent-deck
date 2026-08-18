import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadServerConfig, loadWorkerConfig } from './config.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

async function fullFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-deck-full-config-')));
  temporaryRoots.push(root);
  const files = {
    config: join(root, 'deploy.json'),
    credentials: join(root, 'credentials.json'),
    identity: join(root, 'identity'),
    knownHosts: join(root, 'known_hosts'),
    runtime: join(root, 'runtime.json'),
  };
  await mkdir(join(root, 'repo'));
  await Promise.all([
    writeFile(files.identity, 'private fixture\n', { mode: 0o600 }),
    writeFile(files.knownHosts, 'full.example.test ssh-ed25519 fixture\n', { mode: 0o644 }),
  ]);
  await chmod(root, 0o700);
  return { files, repoRoot: join(root, 'repo') };
}

function runtime(schemaVersion = 1) {
  return {
    schemaVersion,
    instanceId: 'full-a',
    appVersion: '0.1.0',
    runtimeModule: '/opt/agent-deck/linux-headless/server-core-runtime/index.mjs',
    runtimeOptions: {},
    socketPath: '/run/agent-deck/full-a/agent-deckd.sock',
  };
}

async function writeFixture(files, runtimeValue, credentialValue) {
  await Promise.all([
    writeFile(files.runtime, JSON.stringify(runtimeValue), { mode: 0o600 }),
    writeFile(files.credentials, JSON.stringify(credentialValue), { mode: 0o600 }),
  ]);
  await writeFile(files.config, JSON.stringify({
    schemaVersion: 1,
    name: 'full-a',
    ssh: {
      host: 'full.example.test',
      port: 22,
      user: 'operator',
      identityFile: files.identity,
      knownHostsFile: files.knownHosts,
    },
    service: { user: 'agentdeck', uid: 1001, home: '/var/lib/agent-deck' },
    instance: {
      id: 'full-a',
      runtimeConfigFile: files.runtime,
      fullResources: {
        cpuCores: 2,
        memoryBytes: 4_294_967_296,
        pids: 512,
        rootfsBytes: 10_737_418_240,
        tmpfsBytes: 536_870_912,
        logBytes: 268_435_456,
      },
    },
    image: { reference: `registry.example.test/agent-deck-full@${digest}` },
    secrets: {
      credentialsFile: files.credentials,
      claudeCredentialsFile: null,
      codexAuthFile: null,
      grokAuthFile: null,
    },
    acceptance: { egressVerified: true, quotaVerified: true },
  }), { mode: 0o600 });
}

describe('current Full deployment schemas', () => {
  it('rejects an unversioned pre-release runtime config', async () => {
    const fixture = await fullFixture();
    await writeFixture(fixture.files, { instanceId: 'full-a' }, {
      schemaVersion: 3,
      instanceId: 'full-a',
      credentials: [],
    });
    await expect(loadServerConfig(
      fixture.files.config,
      'full',
      fixture.repoRoot,
    )).rejects.toThrow(/runtimeConfig/);
  });

  it('rejects the retired Full credential schema v1', async () => {
    const fixture = await fullFixture();
    await writeFixture(fixture.files, runtime(), {
      schemaVersion: 1,
      instanceId: 'full-a',
      credentials: [],
    });
    await expect(loadServerConfig(
      fixture.files.config,
      'full',
      fixture.repoRoot,
    )).rejects.toThrow(/schemaVersion.*3/);
  });

  it('accepts the exact current Full runtime and credential schemas', async () => {
    const fixture = await fullFixture();
    await writeFixture(fixture.files, runtime(), {
      schemaVersion: 3,
      instanceId: 'full-a',
      credentials: [],
    });
    await expect(loadServerConfig(
      fixture.files.config,
      'full',
      fixture.repoRoot,
    )).resolves.toMatchObject({
      runtimeConfig: { schemaVersion: 1, instanceId: 'full-a' },
    });
  });
});

describe('current Worker Provider supervisor schema', () => {
  it('rejects an incomplete pre-release host config', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-deck-worker-config-')));
    temporaryRoots.push(root);
    const repoRoot = join(root, 'repo');
    const bin = join(root, 'bin');
    const providerSession = join(root, 'provider-session');
    const workspace = join(root, 'workspace');
    const wrapper = join(bin, 'agent-deck-worker');
    const command = join(bin, 'agent-deck-provider-supervisor');
    const supervisorConfig = join(root, 'provider-supervisor.json');
    const credential = join(root, 'grok-auth.json');
    const config = join(root, 'worker.json');
    await Promise.all([
      mkdir(repoRoot),
      mkdir(bin),
      mkdir(providerSession),
      mkdir(workspace),
    ]);
    await Promise.all([
      writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
      writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
      writeFile(credential, '{}\n', { mode: 0o600 }),
      writeFile(
        join(providerSession, 'com.agentdeck.provider-supervisor.plist.in'),
        '<plist>@@INSTANCE_ID@@</plist>\n',
        { mode: 0o644 },
      ),
    ]);
    await writeFile(supervisorConfig, JSON.stringify({
      schemaVersion: 1,
      instanceId: 'relay-a',
      workspaceRoot: workspace,
      privateRoot: join(root, 'private'),
      stateRoot: join(root, 'state'),
      brokerRoot: join(root, 'broker'),
      transportRuntimeDirectory: join(root, 'transport'),
      transportSocketPath: join(root, 'transport', 'supervisor.sock'),
    }), { mode: 0o600 });
    await writeFile(config, JSON.stringify({
      schemaVersion: 1,
      name: 'worker-a',
      wrapper,
      credentialFile: null,
      workspace,
      providerSupervisor: {
        command,
        configFile: supervisorConfig,
        grokCredentialFile: credential,
        workerConfigId: `worker-${'a'.repeat(24)}`,
      },
    }), { mode: 0o600 });

    await expect(loadWorkerConfig(config, repoRoot)).rejects.toThrow(/缺失或多余字段/);
  });
});
