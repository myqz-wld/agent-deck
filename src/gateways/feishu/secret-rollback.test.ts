import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadFeishuProductionConfig, withFeishuSecretMaterial } from './config';
import { HmacPendingActionNonce } from './nonce';
import { createRelayFeishuRuntime } from './runtime';
import { SqliteFeishuGatewayStore } from './sqlite-store';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-secret-')));
  const appSecretPath = join(root, 'app-secret');
  const actionSecretPath = join(root, 'action-secret');
  const configPath = join(root, 'config.json');
  writeFileSync(appSecretPath, `app-${'A'.repeat(40)}\n`, { mode: 0o600 });
  writeFileSync(actionSecretPath, `mac-${'B'.repeat(40)}`, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2,
    topology: 'relay',
    instanceId: 'instance-1',
    appId: 'cli_0123456789abcdef',
    tenantKey: 'tenant_1',
    stateDirectory: root,
    appSecretFile: appSecretPath,
    actionSecretFile: actionSecretPath,
    credentials: [{
      openId: 'ou_owner_1',
      credentialId: 'credential_1',
      connectionScope: 'scope-credential_1',
      status: 'active',
    }],
    callbackWindowMs: 2_800,
    pendingPresentationLifetimeMs: 1_800_000,
    startupTimeoutMs: 15_000,
    reconnectTimeoutMs: 120_000,
    shutdownTimeoutMs: 10_000,
    handshakeTimeoutMs: 10_000,
    pingTimeoutSeconds: 45,
  }), { mode: 0o600 });
  chmodSync(root, 0o700);
  return { actionSecretPath, configPath };
}

describe('production secret rollback and zeroization', () => {
  it('zeroes every allocated Buffer when loading the second secret fails', () => {
    const files = fixture();
    const config = loadFeishuProductionConfig(files.configPath);
    writeFileSync(
      files.actionSecretPath,
      'invalid action secret containing spaces and enough bytes',
      { mode: 0o600 },
    );
    const fill = vi.spyOn(Buffer.prototype, 'fill');
    let contexts: unknown[] = [];
    try {
      expect(() => withFeishuSecretMaterial(config, () => undefined)).toThrow(
        expect.objectContaining({ code: 'invalid_configuration' }),
      );
      contexts = [...fill.mock.contexts];
    } finally {
      fill.mockRestore();
    }
    const buffers = contexts.filter((value): value is Buffer => Buffer.isBuffer(value));
    expect(buffers.length).toBeGreaterThanOrEqual(5);
    expect(buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });

  it('zeroes the caller-visible action Buffer after successful consumption', () => {
    const files = fixture();
    const config = loadFeishuProductionConfig(files.configPath);
    let retained: Uint8Array | null = null;
    withFeishuSecretMaterial(config, (_appSecret, actionSecret) => {
      retained = actionSecret;
    });
    expect(retained).not.toBeNull();
    expect([...retained as unknown as Uint8Array].every((byte) => byte === 0)).toBe(true);
  });

  it('disposes a constructed nonce and closes the store exactly once on later construction failure', () => {
    const files = fixture();
    const originalDispose = HmacPendingActionNonce.prototype.dispose;
    const dispose = vi.spyOn(HmacPendingActionNonce.prototype, 'dispose').mockImplementation(
      function disposeThenFail(this: HmacPendingActionNonce) {
        originalDispose.call(this);
        throw new Error('rollback-disposal-sensitive-value');
      },
    );
    const close = vi.spyOn(SqliteFeishuGatewayStore.prototype, 'close');
    vi.spyOn(SqliteFeishuGatewayStore.prototype, 'getHealth').mockImplementation(() => {
      throw new Error('construction-sensitive-value');
    });
    try {
      let failure: unknown;
      try {
        createRelayFeishuRuntime({
          configPath: files.configPath,
          appVersion: '1.0.0',
          clientFactory: vi.fn() as never,
          auditSink: vi.fn(),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'invalid_configuration' });
      expect(String(failure)).not.toMatch(
        /construction-sensitive-value|rollback-disposal-sensitive-value/u,
      );
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
      const nonce = dispose.mock.contexts[0] as HmacPendingActionNonce;
      const secret = (nonce as unknown as { secret: Buffer }).secret;
      expect([...secret].every((byte) => byte === 0)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
