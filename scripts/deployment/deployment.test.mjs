import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { parseEntrypointArgs, SERVER_ACTIONS } from './common.mjs';
import { loadServerConfig, loadWorkerConfig } from './config.mjs';
import { buildAcceptanceEvidence, renderManagedUnit, sha256 } from './evidence.mjs';
import { buildEvidenceArchive, buildFullSecretsArchive } from './artifacts.mjs';
import { managerFailureCode, relayCutoverRecovery } from './server.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoots = [];
const digest = `sha256:${'a'.repeat(64)}`;

async function temporaryRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-deck-deployment-test-')));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('deployment automation contracts', () => {
  it('requires one exact action and config path', () => {
    expect(parseEntrypointArgs(
      ['--', '--config', '/tmp/config.json', '--dry-run'],
      SERVER_ACTIONS,
    )).toMatchObject({ action: 'dry-run' });
    expect(() => parseEntrypointArgs(
      ['--config', '/tmp/config.json', '--deploy', '--verify'],
      SERVER_ACTIONS,
    )).toThrow(/只能指定一个/);
  });

  it('distinguishes an absent managed instance from other manager failures', () => {
    const missing = new Error('remote command failed');
    missing.result = {
      stderr: '{"schemaVersion":1,"ok":false,"code":"not_found"}\n',
    };
    const tampered = new Error('remote command failed');
    tampered.result = {
      stderr: 'sudo diagnostic\n{"schemaVersion":1,"ok":false,"code":"tampered"}\n',
    };
    expect(managerFailureCode(missing)).toBe('not_found');
    expect(managerFailureCode(tampered)).toBe('tampered');
    expect(managerFailureCode({ managerCode: 'filesystem_failed' })).toBe('filesystem_failed');
    expect(managerFailureCode({ managerCode: 'unsafe\ncode' })).toBeNull();
    expect(managerFailureCode(new Error('transport failed'))).toBeNull();
  });

  it('repairs only an inactive Relay before a generation cutover', () => {
    const state = {
      generation: 1,
      currentVersion: 'git-current',
      versions: [{ version: 'git-current', image: `localhost/relay@${digest}` }],
    };
    const inactive = { systemd: { activeState: 'inactive' } };
    expect(relayCutoverRecovery({ topology: 'relay' }, state, inactive)).toEqual({
      plan: { generation: 1, version: 'git-current' },
      details: state.versions[0],
    });
    expect(relayCutoverRecovery(
      { topology: 'relay' },
      state,
      { systemd: { activeState: 'active' } },
    )).toBeNull();
    expect(relayCutoverRecovery({ topology: 'full' }, state, inactive)).toBeNull();
  });

  it('loads a strict Relay config with pinned SSH and image inputs', async () => {
    const root = await temporaryRoot();
    const identityFile = join(root, 'relay.pem');
    const knownHostsFile = join(root, 'known_hosts');
    const runtimeConfigFile = join(root, 'runtime.json');
    const configFile = join(root, 'deploy.json');
    await writeFile(identityFile, 'private fixture\n', { mode: 0o600 });
    await writeFile(knownHostsFile, 'relay.example.test ssh-ed25519 fixture\n', { mode: 0o644 });
    await writeFile(runtimeConfigFile, JSON.stringify({ instanceId: 'relay-a' }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 1,
      name: 'relay-a',
      ssh: {
        host: 'relay.example.test',
        port: 22,
        user: 'ubuntu',
        identityFile,
        knownHostsFile,
      },
      service: { user: 'agentdeck', uid: 1001, home: '/var/lib/agent-deck' },
      instance: { id: 'relay-a', runtimeConfigFile },
      image: {
        repository: 'localhost/agent-deck-relay',
        runtimeImage: `docker.io/library/node@${digest}`,
      },
      acceptance: {
        egressVerified: true,
        quotaVerified: true,
        stateQuotaBytes: 1_073_741_824,
      },
    }), { mode: 0o600 });
    await expect(loadServerConfig(configFile, 'relay', repoRoot)).resolves.toMatchObject({
      name: 'relay-a',
      topology: 'relay',
      instance: { id: 'relay-a' },
    });
  });

  it('renders evidence exactly bound to the target Relay generation', async () => {
    const config = {
      repoRoot,
      topology: 'relay',
      instance: { id: 'relay-a' },
    };
    const image = `localhost/agent-deck-relay@${digest}`;
    const unit = await renderManagedUnit(config, image);
    const unitSha256 = sha256(unit);
    const evidence = buildAcceptanceEvidence({
      topology: 'relay',
      instanceId: 'relay-a',
      generation: 2,
      version: 'git-abcdef123456',
      image,
      unitSha256,
      stateQuotaBytes: 1_073_741_824,
    });
    expect(unit).toContain(`Image=${image}`);
    expect(evidence.exactEgress).toContain(`unitSha256=${unitSha256}\n`);
    expect(evidence.exactQuota).toContain('generation=2\n');
    expect(evidence.legacyQuota).toContain(
      'statePath=/var/lib/agent-deck/.local/share/agent-deck-relay/relay-a\n',
    );
  });

  it('renders every Full resource placeholder and exact volume evidence', async () => {
    const fullResources = {
      cpuCores: 2.5,
      memoryBytes: 4_294_967_296,
      pids: 512,
      rootfsBytes: 10_737_418_240,
      tmpfsBytes: 536_870_912,
      logBytes: 268_435_456,
    };
    const config = {
      repoRoot,
      topology: 'full',
      instance: { id: 'full-a', fullResources },
    };
    const image = `registry.example.test/agent-deck-full@${digest}`;
    const unit = await renderManagedUnit(config, image);
    const evidence = buildAcceptanceEvidence({
      topology: 'full',
      instanceId: 'full-a',
      generation: 1,
      version: 'git-abcdef123456',
      image,
      unitSha256: sha256(unit),
      fullResources,
    });
    expect(unit).not.toContain('@@');
    expect(unit).toContain('PodmanArgs=--cpus=2.5 --storage-opt=size=10737418240');
    expect(evidence.exactQuota).toContain(
      'volumes=agent-deck-full-a-state,agent-deck-full-a-workspace,agent-deck-full-a-socket,agent-deck-full-a-browser,agent-deck-full-a-secrets\n',
    );
  });

  it('requires the Full credential authority and keeps provider auth optional', async () => {
    const root = await temporaryRoot();
    const identityFile = join(root, 'full.pem');
    const knownHostsFile = join(root, 'known_hosts');
    const runtimeConfigFile = join(root, 'runtime.json');
    const credentialsFile = join(root, 'credentials.json');
    const configFile = join(root, 'full.json');
    await writeFile(identityFile, 'private fixture\n', { mode: 0o600 });
    await writeFile(knownHostsFile, 'core.example.test ssh-ed25519 fixture\n', { mode: 0o644 });
    await writeFile(runtimeConfigFile, JSON.stringify({ instanceId: 'full-a' }), { mode: 0o600 });
    await writeFile(credentialsFile, JSON.stringify({
      schemaVersion: 1,
      instanceId: 'full-a',
      credentials: [],
    }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 1,
      name: 'full-a',
      ssh: {
        host: 'core.example.test',
        port: 22,
        user: 'ubuntu',
        identityFile,
        knownHostsFile,
      },
      service: { user: 'agentdeck', uid: 1001, home: '/var/lib/agent-deck' },
      instance: {
        id: 'full-a',
        runtimeConfigFile,
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
        credentialsFile,
        claudeCredentialsFile: null,
        codexAuthFile: null,
        grokAuthFile: null,
      },
      acceptance: { egressVerified: true, quotaVerified: true },
    }), { mode: 0o600 });
    await expect(loadServerConfig(configFile, 'full', repoRoot)).resolves.toMatchObject({
      topology: 'full',
      secrets: {
        credentialsFile,
        claudeCredentialsFile: null,
      },
    });
  });

  it('creates Full credential archives with private mode before transfer', async () => {
    const root = await temporaryRoot();
    const credentialsFile = join(root, 'credentials.json');
    await writeFile(credentialsFile, JSON.stringify({
      schemaVersion: 1,
      instanceId: 'full-a',
      credentials: [],
    }), { mode: 0o600 });
    const prepared = await buildFullSecretsArchive({
      secrets: {
        credentialsFile,
        claudeCredentialsFile: null,
        codexAuthFile: null,
        grokAuthFile: null,
      },
    });
    try {
      expect((await stat(prepared.archive)).mode & 0o777).toBe(0o600);
    } finally {
      await prepared.cleanup();
    }
  });

  it('omits host extended attributes from portable deployment archives', async () => {
    const prepared = await buildEvidenceArchive({
      legacyEgress: 'legacy egress\n',
      legacyQuota: 'legacy quota\n',
      exactEgress: 'exact egress\n',
      exactQuota: 'exact quota\n',
    });
    try {
      const tarBytes = gunzipSync(await readFile(prepared.archive));
      expect(tarBytes.includes(Buffer.from('LIBARCHIVE.xattr'))).toBe(false);
    } finally {
      await prepared.cleanup();
    }
  });

  it('rejects a Worker workspace inside the Agent Deck repository', async () => {
    const root = await temporaryRoot();
    const credentialFile = join(root, 'worker.agentdeck-connection');
    const configFile = join(root, 'worker.json');
    await writeFile(credentialFile, 'private fixture\n', { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 1,
      name: 'worker-a',
      wrapper: '/bin/echo',
      credentialFile,
      workspace: join(repoRoot, 'worker-workspace'),
    }), { mode: 0o600 });
    await expect(loadWorkerConfig(configFile, repoRoot)).rejects.toThrow(/不能指向 Agent Deck 仓库/);
  });
});
