import { issueRemoteOwnerAccessContext, type JsonValue } from '@contracts/index';
import type { FeishuProductionConfig } from '@gateways/feishu';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from '@clients/ssh/__tests__/fake-process';
import { describe, expect, it } from 'vitest';

import { createFeishuSshClientFactory } from './client-factory';
import { parseFeishuCoreSshConfig } from './config';

const GATEWAY: FeishuProductionConfig = {
  schemaVersion: 3,
  topology: 'full',
  instanceId: 'tenant-a',
  appId: 'cli_1234567890abcdef',
  tenantKey: 'tenant-key',
  stateDirectory: '/var/lib/agent-deck/feishu',
  appSecretFile: '/etc/agent-deck/feishu/app-secret',
  actionSecretFile: '/etc/agent-deck/feishu/action-secret',
  managementSocketPath: '/run/agent-deck-feishu/control.sock',
  credentials: [
    {
      openId: 'open-a',
      credentialId: 'feishu-credential-a',
      connectionScope: 'scope-feishu-credential-a',
      replacesCredentialId: null,
      status: 'active',
    },
  ],
  callbackWindowMs: 2_800,
  pendingPresentationLifetimeMs: 1_800_000,
  startupTimeoutMs: 30_000,
  reconnectTimeoutMs: 60_000,
  shutdownTimeoutMs: 30_000,
  handshakeTimeoutMs: 15_000,
  pingTimeoutSeconds: 30,
};

function sshConfig() {
  return parseFeishuCoreSshConfig({
    schemaVersion: 2,
    topology: 'full',
    instanceId: 'tenant-a',
    appVersion: '0.1.0',
    hostname: 'core.example.test',
    port: 22,
    username: 'agentdeck',
    knownHostsFile: '/etc/agent-deck/feishu/known_hosts',
    hostKeyAlias: null,
    credentials: [
      {
        credentialId: 'feishu-credential-a',
        connectionScope: 'scope-feishu-credential-a',
        identityFile: '/etc/agent-deck/feishu/credential-a.key',
      },
    ],
  });
}

function feishuHello(clientId: string, connectionScope = 'scope-feishu-credential-a') {
  return makeHostHello(clientId, 'full', {
    instanceId: 'tenant-a',
    access: issueRemoteOwnerAccessContext({
      topology: 'full',
      instanceId: 'tenant-a',
      clientId,
      connectionScope,
      surface: 'feishu',
    }),
  });
}

describe('Feishu restricted SSH client factory', () => {
  it('uses the credential-specific key and accepts only a Feishu-bound host hello', async () => {
    const harness = new FakeSpawnHarness();
    const factory = createFeishuSshClientFactory(GATEWAY, sshConfig(), {
      spawn: harness.spawn,
      reconnect: { maxAttempts: 0 },
      timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
    });
    const clientId = 'feishu-chat-client-a';
    const client = factory({
      instanceId: 'tenant-a',
      credentialId: 'feishu-credential-a',
      clientId,
      topology: 'full',
    });
    const connected = client.connect(makeClientHello(clientId));
    const process = harness.latest;
    expect(harness.calls[0].binary).toBe('/usr/bin/ssh');
    expect(harness.calls[0].argv).toContain('/etc/agent-deck/feishu/credential-a.key');
    process.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: feishuHello(clientId),
    } as unknown as JsonValue);
    await connected;
    await client.close();
  });

  it('fails closed for unbound credentials and mismatched host credential claims', async () => {
    const harness = new FakeSpawnHarness();
    const factory = createFeishuSshClientFactory(GATEWAY, sshConfig(), {
      spawn: harness.spawn,
      reconnect: { maxAttempts: 0 },
      timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
    });
    expect(() => factory({
      instanceId: 'tenant-a',
      credentialId: 'unknown-credential',
      clientId: 'feishu-client-unknown',
      topology: 'full',
    })).toThrow('not active');

    const clientId = 'feishu-client-mismatch';
    const client = factory({
      instanceId: 'tenant-a',
      credentialId: 'feishu-credential-a',
      clientId,
      topology: 'full',
    });
    const connecting = client.connect(makeClientHello(clientId));
    const process = harness.latest;
    process.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: feishuHello(clientId, 'another-credential'),
    } as unknown as JsonValue);
    await expect(connecting).rejects.toMatchObject({ code: 'incompatible_handshake' });
    await client.close();
  });

  it('requires the active Gateway credential set to match the SSH identity set exactly', () => {
    expect(() => createFeishuSshClientFactory(GATEWAY, {
      ...sshConfig(),
      credentials: [],
    })).toThrow('exact SSH identity binding');
  });
});
