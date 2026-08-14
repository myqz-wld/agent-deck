import {
  issueRemoteOwnerGrantClaim,
  type AuthenticatedClientAccessContext,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import { describe, expect, it, vi } from 'vitest';

import { ServerCoreDesktopBrokerRuntime } from './desktop-broker-runtime';
import type { ServerCoreDesktopBrokerPort } from './desktop-broker-port';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'full', instanceId: 'instance-a',
  clientId: 'desktop-a', transport: 'ssh', connectionScope: 'credential-a',
  authority: 'owner-equivalent', surface: 'desktop',
  grant: issueRemoteOwnerGrantClaim('desktop'),
};

const feishu: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'full', instanceId: 'instance-a',
  clientId: 'feishu-a', transport: 'feishu', connectionScope: 'credential-feishu',
  authority: 'owner-equivalent', surface: 'feishu',
  grant: issueRemoteOwnerGrantClaim('feishu'),
};

function input(
  method: DaemonRequestInput['method'],
  params: DaemonRequestInput['params'],
  access = desktop,
): DaemonRequestInput {
  return {
    access, method, params, requestId: 'request-a', idempotencyKey: null,
    expectedRevision: null, deadlineAt: null, signal: new AbortController().signal,
  };
}

function harness() {
  const base: DaemonCoreRuntime = {
    supportedMethods: ['system.health'],
    start: async () => undefined,
    stop: async () => undefined,
    currentRevision: () => 7,
    execute: vi.fn(async () => ({ result: { ok: true, revision: 7 }, revision: 7 })),
  };
  const broker = {
    start: async () => undefined,
    stop: async () => undefined,
    invoke: vi.fn(),
    next: vi.fn(async () => ({ request: null })),
    respond: vi.fn(() => ({ accepted: true as const })),
    releaseSession: vi.fn(),
    renameSession: vi.fn(),
  } satisfies ServerCoreDesktopBrokerPort;
  return { base, broker, runtime: new ServerCoreDesktopBrokerRuntime(base, broker) };
}

describe('ServerCoreDesktopBrokerRuntime', () => {
  it('adds both ephemeral desktop methods and preserves the Core revision', async () => {
    const { broker, runtime } = harness();
    expect(runtime.supportedMethods).toEqual([
      'system.health', 'desktop.broker.next', 'desktop.broker.respond',
    ]);
    await expect(runtime.execute(input('desktop.broker.next', { waitMs: 100 }))).resolves.toEqual({
      result: { request: null, revision: 7 },
      revision: 7,
    });
    await expect(runtime.execute(input('desktop.broker.respond', {
      requestId: 'request-a',
      result: { content: [{ type: 'text', text: '{}' }] },
    }))).resolves.toEqual({ result: { accepted: true, revision: 7 }, revision: 7 });
    expect(broker.next).toHaveBeenCalledOnce();
    expect(broker.respond).toHaveBeenCalledOnce();
  });

  it('rejects Feishu access and malformed desktop responses before broker mutation', async () => {
    const { broker, runtime } = harness();
    await expect(runtime.execute(input(
      'desktop.broker.next', { waitMs: 100 }, feishu,
    ))).rejects.toMatchObject({ code: 'access_denied' });
    await expect(runtime.execute(input('desktop.broker.respond', {
      requestId: 'request-a',
      result: { content: [], savedPath: '/private/desktop.png' },
    }))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(broker.next).not.toHaveBeenCalled();
    expect(broker.respond).not.toHaveBeenCalled();
  });
});
