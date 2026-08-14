import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { parseEntrypointArgs, SERVER_ACTIONS } from './common.mjs';
import { loadServerConfig, loadWorkerConfig } from './config.mjs';
import { runWorkerDeployment, workerConfigureArgs } from './worker.mjs';
import {
  bootstrapLaunchAgentWithRetry,
  launchAgentProcessId,
  waitForLaunchAgentProcessExit,
} from './worker-supervisor.mjs';
import { buildAcceptanceEvidence, renderManagedUnit, sha256 } from './evidence.mjs';
import { buildEvidenceArchive, buildFullSecretsArchive } from './artifacts.mjs';
import {
  existingInstanceNeedsStart,
  managerFailureCode,
  RELEASE_UPLOAD_TIMEOUT_MS,
  relayCutoverRecovery,
} from './server.mjs';

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
  it('gives the release archive a bounded slow-link upload window', () => {
    expect(RELEASE_UPLOAD_TIMEOUT_MS).toBe(1_200_000);
  });

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

  it('does not start an already-active existing instance during same-release deploy', () => {
    expect(existingInstanceNeedsStart({ systemd: { activeState: 'active' } })).toBe(false);
    expect(existingInstanceNeedsStart({ systemd: { activeState: 'inactive' } })).toBe(true);
  });

  it('loads a strict Relay config with pinned SSH and image inputs', async () => {
    const root = await temporaryRoot();
    const identityFile = join(root, 'relay.pem');
    const knownHostsFile = join(root, 'known_hosts');
    const runtimeConfigFile = join(root, 'runtime.json');
    const configFile = join(root, 'deploy.json');
    await writeFile(identityFile, 'private fixture\n', { mode: 0o600 });
    await writeFile(knownHostsFile, 'relay.example.test ssh-ed25519 fixture\n', { mode: 0o644 });
    await writeFile(runtimeConfigFile, JSON.stringify({
      schemaVersion: 2,
      instanceId: 'relay-a',
      tickIntervalMs: 1_000,
      plumbingModule: null,
      authorityFile: '/etc/agent-deck-relay/relay-a/authority.json',
    }), { mode: 0o600 });
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
      runtimeConfig: {
        schemaVersion: 2,
        authorityFile: '/etc/agent-deck-relay/relay-a/authority.json',
      },
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
    expect(evidence.runtimeQuota).toContain(
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
      runtimeEgress: 'runtime egress\n',
      runtimeQuota: 'runtime quota\n',
      exactEgress: 'exact egress\n',
      exactQuota: 'exact quota\n',
    });
    try {
      const tarBytes = gunzipSync(await readFile(prepared.archive));
      expect(tarBytes.includes(Buffer.from('runtime-egress'))).toBe(true);
      expect(tarBytes.includes(Buffer.from('runtime-quota'))).toBe(true);
      expect(tarBytes.includes(Buffer.from('exact-egress'))).toBe(true);
      expect(tarBytes.includes(Buffer.from('exact-quota'))).toBe(true);
      expect(tarBytes.includes(Buffer.from('LIBARCHIVE.xattr'))).toBe(false);
    } finally {
      await prepared.cleanup();
    }
  });

  it('installs Feishu runtime releases through separate desired and active digest pointers', async () => {
    const install = await readFile(join(repoRoot, 'scripts/deployment/remote-install.sh'), 'utf8');
    const verify = await readFile(join(repoRoot, 'scripts/deployment/remote-verify.sh'), 'utf8');
    expect(install).toContain('install_runtime_pointer desired');
    expect(install).toContain('if [[ ! -e /opt/agent-deck/feishu-runtime/active ]]');
    expect(install).toContain('/usr/bin/sha256sum --check --strict SHA256SUMS');
    expect(install).toContain('/bin/rm -f -- "$archive"');
    expect(install).toContain('-C "$runtime_stage"');
    expect(install).not.toContain('runtime_extract');
    expect(verify).toContain('/opt/agent-deck/feishu-runtime/desired');
    expect(verify).toContain('agent-deck-feishu check-abi');
  });

  it('keeps the mutable Relay authority outside generation-managed config', async () => {
    const installer = await readFile(
      join(repoRoot, 'scripts/deployment/remote-relay-authority.sh'),
      'utf8',
    );
    const server = await readFile(join(repoRoot, 'scripts/deployment/server.mjs'), 'utf8');
    const quadlet = await readFile(
      join(repoRoot, 'deploy/linux/relay/agent-deck-relay@.container'),
      'utf8',
    );
    expect(installer).toContain('authority_file="$config_directory/authority.json"');
    expect(installer).toContain('"wx", 0o600');
    expect(server).toContain("await ensureRelayAuthority(config, 'create')");
    expect(server).toContain("await ensureRelayAuthority(config, 'verify')");
    expect(quadlet).toContain(
      'Volume=%h/.config/agent-deck-relay/%i:/etc/agent-deck-relay/%i:ro,Z',
    );
    expect(quadlet).not.toContain('config.json:/etc/agent-deck-relay');
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

  it('loads one Worker Provider supervisor from the same packaged application', async () => {
    const root = await temporaryRoot();
    const bin = join(root, 'bin');
    const providerSession = join(root, 'provider-session');
    const workspace = join(root, 'workspace');
    const wrapper = join(bin, 'agent-deck-worker');
    const command = join(bin, 'agent-deck-provider-supervisor');
    const templateFile = join(
      providerSession,
      'com.agentdeck.provider-supervisor.plist.in',
    );
    const supervisorConfigFile = join(root, 'provider-supervisor.json');
    const grokCredentialFile = join(root, 'grok-auth.json');
    const configFile = join(root, 'worker.json');
    const workerConfigId = `worker-${'a'.repeat(24)}`;
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(providerSession, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    await writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(templateFile, '<plist>@@INSTANCE_ID@@</plist>\n', { mode: 0o644 });
    await writeFile(grokCredentialFile, '{"fixture":true}\n', { mode: 0o600 });
    await writeFile(supervisorConfigFile, JSON.stringify({
      schemaVersion: 1,
      instanceId: 'aws-relay-on-mac',
      workspaceRoot: workspace,
      privateRoot: join(root, 'private'),
      stateRoot: join(root, 'state'),
      brokerRoot: join(root, 'broker'),
      transportRuntimeDirectory: join(root, 'transport'),
      transportSocketPath: join(root, 'transport', 'supervisor.sock'),
    }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 1,
      name: 'worker-with-grok-supervisor',
      wrapper,
      credentialFile: null,
      workspace,
      providerSupervisor: {
        command,
        configFile: supervisorConfigFile,
        grokCredentialFile,
        workerConfigId,
      },
    }), { mode: 0o600 });

    const loaded = await loadWorkerConfig(configFile, repoRoot);
    expect(loaded).toMatchObject({
      providerSupervisor: {
        command,
        configFile: supervisorConfigFile,
        grokCredentialFile,
        templateFile,
        workerConfigId,
        hostConfig: {
          instanceId: 'aws-relay-on-mac',
          transportSocketPath: join(root, 'transport', 'supervisor.sock'),
        },
      },
    });
    await expect(runWorkerDeployment(loaded, 'dry-run')).resolves.toMatchObject({
      mutatesLocalState: false,
      providerSupervisor: 'managed-through-launchd',
      plannedSteps: expect.arrayContaining([
        '从本机 Provider 配置自动投影 Remote Gateway、Provider 与模型摘要',
      ]),
    });
    expect(workerConfigureArgs({ ...loaded, credentialFile: '/private/worker.credential' })).toEqual([
      'configure', '--credential', '/private/worker.credential', '--workspace', workspace,
    ]);
  });

  it('retries transient macOS launchctl bootstrap failures only while the job is absent', async () => {
    const calls = [];
    const waits = [];
    const results = [
      { code: 5 },
      { code: 113 },
      { code: 0 },
    ];
    await bootstrapLaunchAgentWithRetry({
      domain: 'gui/501',
      plistPath: '/Users/test/Library/LaunchAgents/provider.plist',
      target: 'gui/501/com.agentdeck.provider-supervisor.test',
      execute: async (args, allowFailure) => {
        calls.push({ args, allowFailure });
        return results.shift();
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(calls).toEqual([
      {
        args: [
          'bootstrap', 'gui/501',
          '/Users/test/Library/LaunchAgents/provider.plist',
        ],
        allowFailure: true,
      },
      {
        args: ['print', 'gui/501/com.agentdeck.provider-supervisor.test'],
        allowFailure: true,
      },
      {
        args: [
          'bootstrap', 'gui/501',
          '/Users/test/Library/LaunchAgents/provider.plist',
        ],
        allowFailure: true,
      },
    ]);
    expect(waits).toEqual([100]);
  });

  it('waits for the previous Provider supervisor process before bootstrapping its replacement', async () => {
    expect(launchAgentProcessId('state = running\n\tpid = 54321\n')).toBe(54321);
    expect(launchAgentProcessId('state = waiting\n')).toBeNull();
    const waits = [];
    const results = [
      { code: 0, stdout: '54321\n' },
      { code: 1, stdout: '' },
    ];
    await waitForLaunchAgentProcessExit(54321, {
      probe: async () => results.shift(),
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(waits).toEqual([100]);
  });
});
