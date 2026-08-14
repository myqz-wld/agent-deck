import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@contracts/index';
import type { ServerControlConfig } from './config';
import { FeishuControlService } from './feishu-control-service';
import type { FeishuManagementClientPort } from './feishu-management-client';
import type { FeishuProvisioningPaths } from './feishu-provisioning';
import type { SystemdControlPort } from './systemd';

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH host\n';
const roots: string[] = [];
const FIRST_RUNTIME_DIGEST = 'a'.repeat(64);

function createRuntimeRelease(releases: string, digest: string): void {
  const root = join(releases, digest);
  mkdirSync(join(root, 'bin'), { recursive: true, mode: 0o755 });
  mkdirSync(join(root, 'app'), { recursive: true, mode: 0o755 });
  for (const path of [root, join(root, 'bin'), join(root, 'app')]) chmodSync(path, 0o755);
  writeFileSync(join(root, 'bin/node'), 'fixture\n', { mode: 0o755 });
  writeFileSync(join(root, 'app/index.mjs'), 'fixture\n', { mode: 0o644 });
  writeFileSync(join(root, 'runtime.json'), '{}\n', { mode: 0o644 });
  writeFileSync(join(root, 'SHA256SUMS'), 'fixture\n', { mode: 0o644 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeSystemd implements SystemdControlPort {
  active = false;
  failEnable = false;
  restartCalls = 0;
  restartFailures = 0;
  daemonReload(): void {}
  enableNow(): void {
    if (this.failEnable) throw new Error('systemd start failed');
    this.active = true;
  }
  restart(): void {
    this.restartCalls += 1;
    if (!this.active) throw new Error('inactive');
    if (this.restartFailures > 0) {
      this.restartFailures -= 1;
      throw new Error('systemd restart failed');
    }
  }
  stopDisable(): void { this.active = false; }
  isActive(): boolean { return this.active; }
}

class FakeManagement implements FeishuManagementClientPort {
  readonly calls: Array<{ method: string; params: Record<string, JsonValue> }> = [];
  private readonly candidate = {
    instanceId: 'instance-a', requestId: 'request-1', codeId: 'code-1',
    appId: 'cli_0123456789abcdef', tenantKey: 'tenant_1', openId: 'ou_owner_secret',
    chatId: 'oc_chat_secret', displayName: 'Owner', status: 'pending', credentialId: null,
    expiresAt: 2_000, createdAt: 100, decidedAt: null,
  };
  constructor(private readonly topology: 'relay' | 'full') {}
  request(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    this.calls.push({ method, params });
    if (method === 'status') {
      return Promise.resolve({
        instanceId: 'instance-a',
        topology: this.topology,
        connection: { state: 'connected' },
        core: { state: 'unverified', verifiedAt: null },
        pairing: { paired: false, openId: null, pending: 0 },
      });
    }
    if (method === 'verify') {
      return Promise.resolve({
        state: 'connected', topology: this.topology, verifiedAt: 100,
        policy: 'Remote Owner Product v1', policyVersion: 1, policyRevision: 1,
        productMethodCount: 1, channelMethodCount: 1, broaderMethodDenied: true,
      });
    }
    if (method === 'pair.code.create') return Promise.resolve({ code: 'A'.repeat(32), expiresAt: 2_000 });
    if (method === 'pair.list') return Promise.resolve({ requests: [this.candidate] });
    const status = method === 'pair.approve' ? 'approved' : 'rejected';
    return Promise.resolve({ state: status, request: { ...this.candidate, status } });
  }
}

function fixture(topology: 'relay' | 'full') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-control-')));
  roots.push(root);
  const configDirectory = join(root, 'etc');
  const stateDirectory = join(root, 'state');
  const runtimeRoot = join(root, 'runtime');
  const runtimeReleases = join(runtimeRoot, 'releases');
  mkdirSync(configDirectory, { mode: 0o750 });
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(runtimeReleases, { recursive: true, mode: 0o755 });
  chmodSync(configDirectory, 0o750);
  chmodSync(stateDirectory, 0o700);
  chmodSync(runtimeRoot, 0o755);
  chmodSync(runtimeReleases, 0o755);
  createRuntimeRelease(runtimeReleases, FIRST_RUNTIME_DIGEST);
  const runtimeActive = join(runtimeRoot, 'active');
  const runtimeDesired = join(runtimeRoot, 'desired');
  writeFileSync(runtimeActive, `${FIRST_RUNTIME_DIGEST}\n`, { mode: 0o644 });
  writeFileSync(runtimeDesired, `${FIRST_RUNTIME_DIGEST}\n`, { mode: 0o644 });
  const authorityFile = join(root, 'authority.json');
  const authorizedKeysFile = join(root, 'authorized_keys');
  const hostKeyFile = join(root, 'host-key.pub');
  const appSecretFile = join(root, 'source-app-secret');
  const originalAuthority = topology === 'relay'
    ? {
        schemaVersion: 1, instanceId: 'instance-a', tickIntervalMs: 1_000,
        plumbingModule: null, credentials: [],
      }
    : { schemaVersion: 3, instanceId: 'instance-a', credentials: [] };
  writeFileSync(authorityFile, `${JSON.stringify(originalAuthority)}\n`, { mode: 0o600 });
  writeFileSync(authorizedKeysFile, 'ssh-ed25519 AAAATEST unmanaged\n', { mode: 0o600 });
  writeFileSync(hostKeyFile, HOST_KEY, { mode: 0o644 });
  writeFileSync(appSecretFile, `app-${'S'.repeat(40)}\n`, { mode: 0o600 });
  chmodSync(authorityFile, 0o600);
  chmodSync(authorizedKeysFile, 0o600);
  chmodSync(hostKeyFile, 0o644);
  chmodSync(appSecretFile, 0o600);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const config: ServerControlConfig = {
    schemaVersion: 2,
    appVersion: '0.1.0',
    instanceId: 'instance-a',
    topology,
    authorityFile,
    authorizedKeysFile,
    endpoint: {
      hostname: `${topology}.example.test`, port: 22, username: 'agentdeck', hostKeyFile,
    },
    relayRuntimeUid: topology === 'relay' ? 1001 : null,
    feishuIdentityOwner: { uid, gid },
  };
  const paths: FeishuProvisioningPaths = {
    configDirectory,
    stateDirectory,
    gatewayConfig: join(configDirectory, 'config.json'),
    coreSshConfig: join(configDirectory, 'core-ssh.json'),
    appSecret: join(configDirectory, 'app-secret'),
    actionSecret: join(configDirectory, 'action-secret'),
    knownHosts: join(configDirectory, 'known-hosts'),
    identity: join(configDirectory, 'identity'),
    managementSocket: join(root, 'control.sock'),
    serviceUnit: 'agent-deck-feishu.service',
    runtimeRoot,
    runtimeReleases,
    runtimeActive,
    runtimeDesired,
  };
  const systemd = new FakeSystemd();
  const management = new FakeManagement(topology);
  const runtimeVerifier = { verifyActive: vi.fn() };
  const service = new FeishuControlService(config, {
    paths, systemd, managementClient: management, runtimeVerifier, now: () => 100,
  });
  const request = {
    schemaVersion: 1 as const,
    appId: 'cli_0123456789abcdef',
    tenantKey: 'tenant_1',
    credentialId: 'feishu-a',
    label: 'Production Feishu',
    appSecretFile,
  };
  return {
    root, paths, config, systemd, management, runtimeVerifier, service, request,
    originalAuthority: `${JSON.stringify(originalAuthority)}\n`,
  };
}

describe.each(['relay', 'full'] as const)('Feishu one-click server control: %s', (topology) => {
  it('provisions one unpaired credential, verifies health, pairs, and disconnects', async () => {
    const test = fixture(topology);
    const connected = await test.service.connect(test.request);
    expect(connected).toMatchObject({ status: 'connected', credentialId: 'feishu-a' });
    expect(test.systemd.active).toBe(true);
    for (const path of [
      test.paths.gatewayConfig, test.paths.coreSshConfig, test.paths.appSecret,
      test.paths.actionSecret, test.paths.knownHosts, test.paths.identity,
    ]) expect(statSync(path).mode & 0o777).toBe(0o600);
    const gateway = JSON.parse(readFileSync(test.paths.gatewayConfig, 'utf8'));
    expect(gateway).toMatchObject({
      schemaVersion: 3,
      topology,
      credentials: [{ openId: null, credentialId: 'feishu-a', status: 'active' }],
    });
    expect(JSON.stringify(gateway)).not.toContain('app-SSSS');
    expect(readFileSync(test.paths.appSecret, 'utf8')).toBe(`app-${'S'.repeat(40)}`);
    expect(readFileSync(test.config.authorizedKeysFile, 'utf8')).toContain('--surface feishu');
    expect(await test.service.connect(test.request)).toMatchObject({ status: 'already-connected' });
    expect(test.service.check()).toMatchObject({ status: 'ready', topology });
    expect(test.runtimeVerifier.verifyActive).toHaveBeenCalled();
    expect(test.service.dryRun(test.request)).toMatchObject({ status: 'already-connected' });
    expect(await test.service.verify()).toMatchObject({ service: 'active' });
    expect(await test.service.pairCreate()).toMatchObject({ code: 'A'.repeat(32) });
    const pairingOutputs = [
      await test.service.pairList(),
      await test.service.pairApprove('request-1'),
      await test.service.pairReject('request-2'),
    ];
    expect(pairingOutputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ requests: [expect.objectContaining({
        requestId: 'request-1', displayName: 'Owner',
        identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })] }),
    ]));
    expect(JSON.stringify(pairingOutputs)).not.toContain('ou_owner_secret');
    expect(JSON.stringify(pairingOutputs)).not.toContain('oc_chat_secret');
    expect(JSON.stringify(pairingOutputs)).not.toContain('tenant_1');
    expect(test.management.calls.map((call) => call.method)).toEqual(expect.arrayContaining([
      'pair.code.create', 'pair.list', 'pair.approve', 'pair.reject',
    ]));

    expect(await test.service.disconnect({
      schemaVersion: 1, credentialId: 'feishu-a',
    })).toMatchObject({ status: 'disconnected', statePreserved: true });
    expect(test.systemd.active).toBe(false);
    expect(statSync(test.paths.stateDirectory).isDirectory()).toBe(true);
    expect(readFileSync(test.config.authorizedKeysFile, 'utf8')).not.toContain('--surface feishu');
    for (const path of [
      test.paths.gatewayConfig, test.paths.coreSshConfig, test.paths.appSecret,
      test.paths.actionSecret, test.paths.knownHosts, test.paths.identity,
    ]) expect(() => statSync(path)).toThrow();
  });

  it('restores authority and removes every protected output when service start fails', async () => {
    const test = fixture(topology);
    test.systemd.failEnable = true;
    const originalKeys = readFileSync(test.config.authorizedKeysFile, 'utf8');
    await expect(test.service.connect(test.request)).rejects.toThrow('systemd start failed');
    expect(readFileSync(test.config.authorityFile, 'utf8')).toBe(test.originalAuthority);
    expect(readFileSync(test.config.authorizedKeysFile, 'utf8')).toBe(originalKeys);
    for (const path of [
      test.paths.gatewayConfig, test.paths.coreSshConfig, test.paths.appSecret,
      test.paths.actionSecret, test.paths.knownHosts, test.paths.identity,
    ]) expect(() => statSync(path)).toThrow();
  });

  it('rotates to a new credential id once and rewrites the sidecar identity atomically', async () => {
    const test = fixture(topology);
    await test.service.connect(test.request);
    const firstIdentity = readFileSync(test.paths.identity, 'utf8');
    const request = {
      schemaVersion: 1 as const,
      credentialId: 'feishu-a',
      nextCredentialId: 'feishu-b',
      label: 'Rotated Feishu',
    };
    expect(await test.service.rotateCredential(request)).toMatchObject({
      status: 'rotated', credentialId: 'feishu-b', replacedCredentialId: 'feishu-a',
    });
    expect(readFileSync(test.paths.identity, 'utf8')).not.toBe(firstIdentity);
    const gateway = JSON.parse(readFileSync(test.paths.gatewayConfig, 'utf8'));
    expect(gateway.credentials).toMatchObject([{
      credentialId: 'feishu-b', openId: null, replacesCredentialId: null, status: 'active',
    }]);
    const authority = JSON.parse(readFileSync(test.config.authorityFile, 'utf8'));
    const credentials = authority.credentials.filter(
      (entry: { kind?: string }) => entry.kind !== 'relay-worker',
    );
    expect(credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ credentialId: 'feishu-a', status: 'revoked' }),
      expect.objectContaining({ credentialId: 'feishu-b', status: 'active' }),
    ]));
    expect(await test.service.rotateCredential(request)).toMatchObject({
      status: 'already-rotated', credentialId: 'feishu-b',
    });
    expect(test.systemd.restartCalls).toBe(2);
  });

  it('restores old authority, config, and identity when rotated service restart fails', async () => {
    const test = fixture(topology);
    await test.service.connect(test.request);
    const before = {
      authority: readFileSync(test.config.authorityFile, 'utf8'),
      keys: readFileSync(test.config.authorizedKeysFile, 'utf8'),
      gateway: readFileSync(test.paths.gatewayConfig, 'utf8'),
      core: readFileSync(test.paths.coreSshConfig, 'utf8'),
      identity: readFileSync(test.paths.identity, 'utf8'),
    };
    test.systemd.restartFailures = 1;
    await expect(test.service.rotateCredential({
      schemaVersion: 1,
      credentialId: 'feishu-a',
      nextCredentialId: 'feishu-b',
      label: 'Rotated Feishu',
    })).rejects.toThrow('systemd restart failed');
    expect(readFileSync(test.config.authorityFile, 'utf8')).toBe(before.authority);
    expect(readFileSync(test.config.authorizedKeysFile, 'utf8')).toBe(before.keys);
    expect(readFileSync(test.paths.gatewayConfig, 'utf8')).toBe(before.gateway);
    expect(readFileSync(test.paths.coreSshConfig, 'utf8')).toBe(before.core);
    expect(readFileSync(test.paths.identity, 'utf8')).toBe(before.identity);
    expect(test.systemd.active).toBe(true);
  });

  it('atomically restores the prior runtime when an upgrade fails health activation', async () => {
    const test = fixture(topology);
    await test.service.connect(test.request);
    const nextDigest = 'b'.repeat(64);
    createRuntimeRelease(test.paths.runtimeReleases, nextDigest);
    writeFileSync(test.paths.runtimeDesired, `${nextDigest}\n`, { mode: 0o644 });
    test.systemd.restartFailures = 1;
    await expect(test.service.upgrade()).rejects.toThrow('systemd restart failed');
    expect(readFileSync(test.paths.runtimeActive, 'utf8')).toBe(`${FIRST_RUNTIME_DIGEST}\n`);
    expect(test.systemd.active).toBe(true);
    await expect(test.service.upgrade()).resolves.toMatchObject({
      status: 'upgraded',
      runtime: { activeDigest: nextDigest, previousDigest: FIRST_RUNTIME_DIGEST },
    });
    expect(readFileSync(test.paths.runtimeActive, 'utf8')).toBe(`${nextDigest}\n`);
  });
});
