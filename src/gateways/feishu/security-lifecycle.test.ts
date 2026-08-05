import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  type FeishuGatewayClock,
  type PendingActionNonceBinding,
} from '@gateways/im';
import { createFeishuAuditBundle } from './audit';
import { loadFeishuProductionConfig, withFeishuSecretMaterial } from './config';
import { FeishuLongConnection } from './long-connection';
import { HmacPendingActionNonce } from './nonce';
import { createRelayFeishuRuntime, createServerCoreFeishuRuntime } from './runtime';
import type {
  FeishuConnectionHealth,
  FeishuHealthStore,
  FeishuOperationalAuditEntry,
  FeishuSdkConnectionCallbacks,
  FeishuSdkConnectionPort,
} from './types';

const binding = {
  appId: 'cli_0123456789abcdef',
  tenantKey: 'tenant_1',
  instanceId: 'instance-1',
  topology: 'relay' as const,
};
const NOW = 1_710_000_000_000;

class ManualClock implements FeishuGatewayClock {
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(private time = 1_000) {}

  now(): number {
    return this.time;
  }

  setTimer(callback: () => void, delayMs: number): { cancel(): void } {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return { cancel: () => this.timers.delete(id) };
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.time)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

class MemoryHealth implements FeishuHealthStore {
  value: FeishuConnectionHealth | null = null;

  getHealth(instanceId: string): FeishuConnectionHealth | null {
    return this.value?.instanceId === instanceId ? { ...this.value } : null;
  }

  putHealth(value: FeishuConnectionHealth): void {
    this.value = { ...value };
  }
}

function lifecycleFixture() {
  const clock = new ManualClock();
  const health = new MemoryHealth();
  const entries: FeishuOperationalAuditEntry[] = [];
  const audit = createFeishuAuditBundle(binding, clock, (entry) => entries.push(entry));
  let callbacks: FeishuSdkConnectionCallbacks | null = null;
  const port: FeishuSdkConnectionPort = {
    start: vi.fn(),
    close: vi.fn(),
  };
  const fatal = vi.fn();
  const connection = new FeishuLongConnection({
    instanceId: binding.instanceId,
    factory: (value) => {
      callbacks = value;
      return port;
    },
    handlers: { onMessage: vi.fn(), onCardAction: vi.fn() },
    health,
    clock,
    audit,
    startupTimeoutMs: 100,
    reconnectTimeoutMs: 200,
    onFatal: fatal,
  });
  return {
    clock, health, entries, port, fatal, connection,
    callbacks: () => callbacks as unknown as FeishuSdkConnectionCallbacks,
  };
}

function secretConfig(root: string): { configPath: string; appSecret: string; actionSecret: string } {
  const appSecret = `app-${'A'.repeat(40)}`;
  const actionSecret = `mac-${'B'.repeat(40)}`;
  const appSecretPath = join(root, 'app-secret');
  const actionSecretPath = join(root, 'action-secret');
  const configPath = join(root, 'config.json');
  writeFileSync(appSecretPath, `${appSecret}\n`, { mode: 0o600 });
  writeFileSync(actionSecretPath, actionSecret, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    topology: 'relay',
    instanceId: 'instance-1',
    appId: binding.appId,
    tenantKey: binding.tenantKey,
    stateDirectory: root,
    appSecretFile: appSecretPath,
    actionSecretFile: actionSecretPath,
    credentials: [{ openId: 'ou_owner_1', credentialId: 'credential_1', status: 'active' }],
    callbackWindowMs: 2_800,
    pendingPresentationLifetimeMs: 1_800_000,
    startupTimeoutMs: 15_000,
    reconnectTimeoutMs: 120_000,
    shutdownTimeoutMs: 10_000,
    handshakeTimeoutMs: 10_000,
    pingTimeoutSeconds: 45,
  }), { mode: 0o600 });
  chmodSync(root, 0o700);
  return { configPath, appSecret, actionSecret };
}

describe('production nonce, config, and audit boundaries', () => {
  const nonceBinding: PendingActionNonceBinding = {
    instanceId: 'instance-1',
    credentialId: 'credential_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    sessionId: 'session_1',
    requestId: 'request_1',
    revision: 4,
    contentDigest: 'sha256_digest_1',
    action: 'approve',
  };

  it('binds the HMAC to every action field and verifies malformed MACs fail closed', () => {
    let now = NOW;
    const nonce = new HmacPendingActionNonce(Buffer.alloc(32, 7), {
      now: () => now,
      defaultLifetimeMs: 100,
    });
    const issued = nonce.issue(nonceBinding);
    expect(nonce.verify(nonceBinding, issued)).toBe(true);
    for (const changed of [
      { ...nonceBinding, chatId: 'oc_chat_2' },
      { ...nonceBinding, revision: 5 },
      { ...nonceBinding, action: 'deny' as const },
      { ...nonceBinding, contentDigest: 'sha256_digest_2' },
    ]) expect(nonce.verify(changed, issued)).toBe(false);
    expect(nonce.verify(nonceBinding, 'v1.not-base64!')).toBe(false);
    expect(nonce.verify(nonceBinding, '')).toBe(false);
    now += 101;
    expect(nonce.verify(nonceBinding, issued)).toBe(false);
  });

  it('MAC-binds the exact presentation deadline while allowing explicit zero lifetime', () => {
    let now = NOW;
    const nonce = new HmacPendingActionNonce(Buffer.alloc(32, 8), { now: () => now });
    const action = {
      name: 'pending.respond' as const,
      ...nonceBinding,
      nonce: 'preliminary',
    };
    const expiring = nonce.signPresentation(action, NOW + 50);
    expect(nonce.verify(nonceBinding, expiring)).toBe(true);
    now += 51;
    expect(nonce.verify(nonceBinding, expiring)).toBe(false);
    const indefinite = nonce.signPresentation(action, null);
    now = Number.MAX_SAFE_INTEGER;
    expect(nonce.verify(nonceBinding, indefinite)).toBe(true);
  });

  it('zeroes the action secret only through an idempotent terminal disposal seam', () => {
    const nonce = new HmacPendingActionNonce(Buffer.alloc(32, 9), { now: () => NOW });
    const retained = (nonce as unknown as { secret: Buffer }).secret;
    const issued = nonce.issue(nonceBinding);
    expect(nonce.verify(nonceBinding, issued)).toBe(true);
    nonce.dispose();
    nonce.dispose();
    expect([...retained].every((byte) => byte === 0)).toBe(true);
    expect(nonce.verify(nonceBinding, issued)).toBe(false);
    expect(() => nonce.issue(nonceBinding)).toThrow(
      expect.objectContaining({ code: 'gateway_closed' }),
    );
  });

  it('loads only protected bounded config and secret files without putting secrets in config', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-')));
    const fixture = secretConfig(root);
    const config = loadFeishuProductionConfig(fixture.configPath);
    expect(config).not.toHaveProperty('appSecret');
    expect(config).not.toHaveProperty('actionSecret');
    withFeishuSecretMaterial(config, (appSecret, actionSecret) => {
      expect(appSecret).toBe(fixture.appSecret);
      expect(Buffer.from(actionSecret).toString()).toBe(fixture.actionSecret);
    });

    chmodSync(config.appSecretFile, 0o644);
    expect(() => withFeishuSecretMaterial(config, () => undefined)).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );
  });

  it('enforces the shared lowercase Linux instance label grammar without narrowing provider ids', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-')));
    const fixture = secretConfig(root);
    const base = JSON.parse(String(readFileSync(fixture.configPath)));
    for (const valid of ['a', 'instance-1', 'a--b', 'a'.repeat(63)]) {
      writeFileSync(fixture.configPath, JSON.stringify({ ...base, instanceId: valid }), { mode: 0o600 });
      expect(loadFeishuProductionConfig(fixture.configPath).instanceId).toBe(valid);
    }
    for (const invalid of [
      '', 'Instance', 'instance_1', 'instance.1', 'instance/1', 'instance$1',
      '-instance', 'instance-', 'a'.repeat(64), 123,
    ]) {
      writeFileSync(fixture.configPath, JSON.stringify({ ...base, instanceId: invalid }), {
        mode: 0o600,
      });
      expect(() => loadFeishuProductionConfig(fixture.configPath)).toThrow(
        expect.objectContaining({ code: 'invalid_configuration' }),
      );
    }
    writeFileSync(fixture.configPath, JSON.stringify({
      ...base,
      instanceId: 'instance-1',
      tenantKey: 'tenant.with/provider:$id',
    }), { mode: 0o600 });
    expect(loadFeishuProductionConfig(fixture.configPath).tenantKey).toBe('tenant.with/provider:$id');
  });

  it('matches the pinned SDK app-id grammar and reserves callback delivery time', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-')));
    const fixture = secretConfig(root);
    const base = JSON.parse(String(readFileSync(fixture.configPath)));
    writeFileSync(fixture.configPath, JSON.stringify({
      ...base,
      appId: 'cli_gggggggggggggggg',
    }), { mode: 0o600 });
    expect(() => loadFeishuProductionConfig(fixture.configPath)).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );

    writeFileSync(fixture.configPath, JSON.stringify({
      ...base,
      callbackWindowMs: 2_801,
    }), { mode: 0o600 });
    expect(() => loadFeishuProductionConfig(fixture.configPath)).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );

    writeFileSync(fixture.configPath, JSON.stringify({
      ...base,
      appId: 'cli_ABCDEF0123456789',
      callbackWindowMs: 2_800,
    }), { mode: 0o600 });
    expect(loadFeishuProductionConfig(fixture.configPath)).toMatchObject({
      appId: 'cli_ABCDEF0123456789',
      callbackWindowMs: 2_800,
    });
  });

  it('rejects config and secret paths reached through a symlinked parent', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-')));
    const fixture = secretConfig(root);
    const alias = join(root, 'alias');
    symlinkSync(root, alias, 'dir');
    expect(() => loadFeishuProductionConfig(join(alias, 'config.json'))).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );

    const config = loadFeishuProductionConfig(fixture.configPath);
    expect(() => withFeishuSecretMaterial({
      ...config,
      appSecretFile: join(alias, 'app-secret'),
    }, () => undefined)).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
  });

  it('rejects unknown config fields and redacts SDK arguments, errors, and audit entries', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-')));
    const fixture = secretConfig(root);
    const raw = JSON.parse(String(readFileSync(fixture.configPath)));
    raw.inlineSecret = fixture.appSecret;
    writeFileSync(fixture.configPath, JSON.stringify(raw), { mode: 0o600 });
    let error: unknown;
    try {
      loadFeishuProductionConfig(fixture.configPath);
    } catch (caught) {
      error = caught;
    }
    expect(JSON.stringify(error)).not.toContain(fixture.appSecret);

    const entries: FeishuOperationalAuditEntry[] = [];
    const audit = createFeishuAuditBundle(binding, new ManualClock(), (entry) => entries.push(entry));
    audit.sdkLogger.error('secret SDK detail', fixture.actionSecret);
    audit.runtime('bad operation with spaces', 'retryable-failure', fixture.appSecret);
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(entries).toMatchObject([
      { component: 'sdk', operation: 'sdk-log', code: 'sdk-error' },
      { component: 'runtime', operation: 'invalid-operation', code: 'redacted-error' },
    ]);
  });

  it('exposes distinct Relay and Server Core factories and rejects topology crossover', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-')));
    const fixture = secretConfig(root);
    const options = {
      configPath: fixture.configPath,
      appVersion: '1.0.0',
      clientFactory: vi.fn() as never,
      auditSink: vi.fn(),
    };
    const relay = createRelayFeishuRuntime(options);
    await relay.close();
    expect(() => createServerCoreFeishuRuntime(options)).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );

    const serverRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-')));
    const serverFixture = secretConfig(serverRoot);
    const config = JSON.parse(String(readFileSync(serverFixture.configPath)));
    config.topology = 'server-core';
    writeFileSync(serverFixture.configPath, JSON.stringify(config), { mode: 0o600 });
    const server = createServerCoreFeishuRuntime({
      ...options,
      configPath: serverFixture.configPath,
    });
    await server.close();
  });
});

describe('bounded outbound long-connection lifecycle', () => {
  it('waits for the official ready callback and records a durable generation', async () => {
    const fixture = lifecycleFixture();
    const started = fixture.connection.start();
    expect(fixture.health.value).toMatchObject({ state: 'starting', generation: 0 });
    fixture.callbacks().onReady();
    await started;
    expect(fixture.health.value).toMatchObject({
      state: 'connected', generation: 1, reconnectAttempts: 0,
    });
    expect(fixture.entries).toContainEqual(expect.objectContaining({ code: 'connected' }));
  });

  it('fails closed when initial readiness exceeds the bound', async () => {
    const fixture = lifecycleFixture();
    const started = fixture.connection.start();
    fixture.clock.advance(100);
    await expect(started).rejects.toMatchObject({ code: 'lifecycle_failed', retryable: true });
    expect(fixture.port.close).toHaveBeenCalledWith(true);
    expect(fixture.health.value).toMatchObject({ state: 'failed', lastErrorCode: 'startup-timeout' });
    expect(fixture.fatal).toHaveBeenCalledWith('startup-timeout');
  });

  it('bounds reconnect, advances generation on success, and ignores callbacks after shutdown', async () => {
    const fixture = lifecycleFixture();
    const started = fixture.connection.start();
    fixture.callbacks().onReady();
    await started;
    fixture.callbacks().onReconnecting();
    fixture.clock.advance(150);
    fixture.callbacks().onReconnected();
    expect(fixture.health.value).toMatchObject({
      state: 'connected', generation: 2, reconnectAttempts: 1,
    });
    fixture.callbacks().onReconnecting();
    fixture.clock.advance(200);
    expect(fixture.health.value).toMatchObject({ state: 'failed', lastErrorCode: 'reconnect-timeout' });
    fixture.connection.close();
    fixture.callbacks().onReconnected();
    expect(fixture.health.value).toMatchObject({
      state: 'failed', generation: 2, lastErrorCode: 'reconnect-timeout',
    });
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });

  it('treats rejected SDK startup as terminal without exposing the dependency error', async () => {
    const fixture = lifecycleFixture();
    vi.mocked(fixture.port.start).mockRejectedValueOnce(new Error('credential-secret-value'));
    await expect(fixture.connection.start()).rejects.toThrow('Feishu long connection failed');
    expect(JSON.stringify(fixture.entries)).not.toContain('credential-secret-value');
    expect(fixture.health.value).toMatchObject({ state: 'failed', lastErrorCode: 'sdk-start-error' });
  });

  it('keeps the terminal cause authoritative when SDK cleanup itself throws', async () => {
    const fixture = lifecycleFixture();
    const started = fixture.connection.start();
    fixture.callbacks().onReady();
    await started;
    vi.mocked(fixture.port.close).mockImplementation(() => {
      throw new Error('sdk-close-sensitive-value');
    });
    expect(() => fixture.callbacks().onError()).not.toThrow();
    expect(fixture.health.value).toMatchObject({
      state: 'failed',
      lastErrorCode: 'sdk-terminal-error',
    });
    expect(fixture.fatal).toHaveBeenCalledWith('sdk-terminal-error');
    expect(() => fixture.connection.close()).toThrow(
      expect.objectContaining({
        code: 'lifecycle_failed',
        message: 'Feishu long connection cleanup failed',
      }),
    );
    expect(fixture.health.value).toMatchObject({ state: 'failed' });
    expect(JSON.stringify(fixture.entries)).not.toContain('sdk-close-sensitive-value');
  });
});
