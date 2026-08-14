import { describe, expect, it } from 'vitest';
import {
  AgentDeckClientErrorCode,
  REMOTE_OWNER_PRODUCT_V1_METHODS,
  type AuthenticatedClientAccessContext,
  type HostHello,
} from '@contracts/index';
import {
  DEFAULT_GATEWAY_CLOCK,
  type FeishuAgentDeckClientFactory,
} from '@gateways/im';
import { FakeCoreClient } from '@gateways/im/__tests__/fixture';
import { createFeishuCoreProbe } from './core-verification';
import type { FeishuProductionConfig } from './types';

const config = {
  schemaVersion: 3,
  topology: 'relay',
  instanceId: 'instance-1',
  appId: 'cli_0123456789abcdef',
  tenantKey: 'tenant-1',
  stateDirectory: '/var/lib/agent-deck-feishu',
  appSecretFile: '/etc/agent-deck-feishu/app-secret',
  actionSecretFile: '/etc/agent-deck-feishu/action-secret',
  managementSocketPath: '/run/agent-deck-feishu/control.sock',
  credentials: [{
    openId: 'ou_owner_1',
    credentialId: 'credential-1',
    connectionScope: 'credential-1',
    replacesCredentialId: null,
    status: 'active',
  }],
  callbackWindowMs: 2_800,
  pendingPresentationLifetimeMs: 1_800_000,
  startupTimeoutMs: 10_000,
  reconnectTimeoutMs: 120_000,
  shutdownTimeoutMs: 10_000,
  handshakeTimeoutMs: 10_000,
  pingTimeoutSeconds: 45,
} as const satisfies FeishuProductionConfig;

function probeFixture(input: {
  readonly allowBroaderMethod?: boolean;
  readonly reduceProductGrant?: boolean;
} = {}) {
  let client: FakeCoreClient | null = null;
  const clientFactory: FeishuAgentDeckClientFactory = (factoryInput) => {
    client = new FakeCoreClient(factoryInput);
    if (input.reduceProductGrant) {
      const hello = client.hello;
      const access = hello.access as AuthenticatedClientAccessContext;
      Object.defineProperty(client, 'hello', {
        value: {
          ...hello,
          access: {
            ...access,
            grant: {
              ...access.grant,
              productMethods: access.grant.productMethods.slice(1),
            },
          },
        } satisfies HostHello,
      });
    }
    client.requestHook = ({ method }) => {
      if (method !== 'system.health' || input.allowBroaderMethod) return undefined;
      throw Object.assign(new Error('denied'), {
        code: AgentDeckClientErrorCode.AccessDenied,
        retryable: false,
      });
    };
    return client;
  };
  const probe = createFeishuCoreProbe(config, {
    appVersion: '1.0.0',
    clientFactory,
    auditSink: () => undefined,
  }, DEFAULT_GATEWAY_CLOCK);
  return { client: () => client as unknown as FakeCoreClient, probe };
}

describe('Feishu Core access verification', () => {
  it('proves the exact owner policy and a live denial outside its grant', async () => {
    const fixture = probeFixture();
    await expect(fixture.probe()).resolves.toEqual({
      topology: 'relay',
      policy: 'Remote Owner Product v1',
      policyVersion: 1,
      policyRevision: 1,
      productMethodCount: REMOTE_OWNER_PRODUCT_V1_METHODS.length,
      channelMethodCount: 1,
      broaderMethodDenied: true,
    });
    expect(fixture.client().calls).toEqual([
      expect.objectContaining({
        method: 'system.health',
        params: {},
        options: { deadlineMs: config.startupTimeoutMs },
      }),
    ]);
    expect(fixture.client().closeCalls).toBe(1);
  });

  it('fails closed when Core allows a method outside the grant', async () => {
    const fixture = probeFixture({ allowBroaderMethod: true });
    await expect(fixture.probe()).rejects.toMatchObject({
      code: 'invalid_core_response',
      message: 'Core allowed a method outside the Feishu owner grant',
    });
    expect(fixture.client().closeCalls).toBe(1);
  });

  it('fails closed when the owner product grant is incomplete', async () => {
    const fixture = probeFixture({ reduceProductGrant: true });
    await expect(fixture.probe()).rejects.toMatchObject({
      code: 'invalid_core_response',
      message: 'Core returned an incomplete Feishu owner grant',
    });
    expect(fixture.client().calls).toEqual([]);
    expect(fixture.client().closeCalls).toBe(1);
  });
});
