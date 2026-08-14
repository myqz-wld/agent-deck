import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FeishuGatewayBinding } from '@gateways/im';
import { SqliteFeishuGatewayStore } from '@gateways/feishu';
import { FeishuManagementClient } from '@hosts/server-control/feishu-management-client';
import { FeishuManagementServer } from './management-server';

const binding: FeishuGatewayBinding = {
  appId: 'cli_0123456789abcdef',
  tenantKey: 'tenant_1',
  instanceId: 'instance-1',
  topology: 'full',
};

describe('Feishu root-local management socket', () => {
  it('uses an owner-only exact protocol for code creation and approval', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-mgmt-')));
    const databasePath = join(root, 'metadata.sqlite3');
    const socketPath = join(root, 'control.sock');
    const store = new SqliteFeishuGatewayStore(databasePath, binding);
    store.reconcileCredentials([{
      openId: null,
      credentialId: 'credential-1',
      connectionScope: 'scope-credential-1',
      replacesCredentialId: null,
      status: 'active',
    }]);
    store.putHealth({
      instanceId: binding.instanceId,
      state: 'connected',
      generation: 1,
      reconnectAttempts: 0,
      lastErrorCode: null,
      updatedAt: 100,
    });
    let now = 100;
    const fatal = vi.fn();
    const server = new FeishuManagementServer({
      socketPath,
      instanceId: binding.instanceId,
      topology: binding.topology,
      target: store,
      coreStatus: () => ({ state: 'unverified', verifiedAt: null }),
      verifyCore: () => Promise.resolve({
        state: 'connected',
        topology: binding.topology,
        verifiedAt: now,
        policy: 'Remote Owner Product v1',
        policyVersion: 1,
        policyRevision: 1,
        productMethodCount: 48,
        channelMethodCount: 1,
        broaderMethodDenied: true,
      }),
      now: () => now,
      onFatal: fatal,
    });
    await server.start();
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const client = new FeishuManagementClient(socketPath, uid);
    expect(await client.request('status', {})).toMatchObject({
      instanceId: binding.instanceId,
      core: { state: 'unverified', verifiedAt: null },
      pairing: { paired: false, pending: 0 },
    });
    expect(await client.request('verify', {})).toMatchObject({
      state: 'connected',
      topology: binding.topology,
      broaderMethodDenied: true,
    });
    const created = await client.request('pair.code.create', {});
    expect(created).toMatchObject({ code: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) });
    await expect(client.request('pair.code.create', {})).rejects.toThrow('rate_limited');
    const code = (created as { code: string }).code;
    now = 101;
    expect(store.consumePairingCode({
      instanceId: binding.instanceId,
      appId: binding.appId,
      tenantKey: binding.tenantKey,
      openId: 'ou_owner_1',
      chatId: 'oc_chat_1',
      displayName: null,
      eventId: 'pair-event-1',
      codeHash: createHash('sha256').update(code).digest('hex'),
      requestId: 'request-1',
      now,
    })).toMatchObject({ state: 'accepted' });
    expect(readFileSync(databasePath).includes(Buffer.from(code))).toBe(false);
    expect(await client.request('pair.list', { status: 'pending' })).toMatchObject({
      requests: [{ requestId: 'request-1', status: 'pending' }],
    });
    expect(await client.request('pair.approve', { requestId: 'request-1' })).toMatchObject({
      state: 'approved',
    });
    expect(await client.request('status', {})).toMatchObject({
      pairing: { paired: true, openId: 'ou_owner_1', pending: 0 },
    });
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
    expect(fatal).not.toHaveBeenCalled();
    store.close();
  });
});
