import type { AuthenticatedClientAccessContext, ClientHello } from '@contracts/index';
import { describe, expect, it, vi } from 'vitest';

import type {
  DaemonCredentialActiveCheck,
  DaemonCredentialIdentity,
  DaemonCredentialLifecyclePort,
} from './credential-lifecycle';
import { DaemonCredentialRegistry } from './credential-lifecycle';
import {
  createHost,
  createRuntime,
  findMessage,
  hello,
  request,
  TestDuplex,
  waitFor,
} from './connection-test-helpers';
import type { DaemonAccessContextFactory, DaemonCoreRuntime } from './types';

const PROCESS_ID = 'server-core:tenant-a';

function key(credentialId: string, surface: string): string {
  return `${surface}\0${credentialId}`;
}

class CredentialLifecycle implements DaemonCredentialLifecyclePort {
  readonly checks: DaemonCredentialIdentity[] = [];
  readonly close = vi.fn(() => undefined);
  private readonly inactive = new Set<string>();
  private listener: ((identity: DaemonCredentialIdentity) => void) | null = null;
  private staleListener: ((identity: DaemonCredentialIdentity) => void) | null = null;
  checkOverride: ((input: DaemonCredentialActiveCheck) => Promise<boolean> | boolean) | null = null;

  isActive(input: DaemonCredentialActiveCheck): Promise<boolean> | boolean {
    this.checks.push(input.identity);
    return this.checkOverride?.(input) ?? !this.inactive.has(key(
      input.identity.accessCredentialId,
      input.identity.accessSurface,
    ));
  }

  subscribeRevocations(onRevoked: (identity: DaemonCredentialIdentity) => void) {
    this.listener = onRevoked;
    this.staleListener = onRevoked;
    return {
      close: () => {
        this.close();
        if (this.listener === onRevoked) this.listener = null;
      },
    };
  }

  deactivate(
    credentialId: string,
    surface: 'desktop-full' | 'feishu-session-console',
  ): void {
    this.inactive.add(key(credentialId, surface));
  }

  revoke(
    credentialId: string,
    surface: 'desktop-full' | 'feishu-session-console',
  ): void {
    this.deactivate(credentialId, surface);
    this.listener?.({
      instanceId: 'tenant-a',
      processId: PROCESS_ID,
      accessCredentialId: credentialId,
      accessSurface: surface,
    });
  }

  invokeStale(credentialId: string): void {
    this.staleListener?.({
      instanceId: 'tenant-a',
      processId: PROCESS_ID,
      accessCredentialId: credentialId,
      accessSurface: 'desktop-full',
    });
  }
}

function accessFor(
  credentialId: string,
  surface: 'desktop-full' | 'feishu-session-console' = 'desktop-full',
): DaemonAccessContextFactory {
  return (clientHello: ClientHello): AuthenticatedClientAccessContext => {
    const common = {
      kind: 'authenticated-client' as const,
      topology: 'server-core' as const,
      instanceId: 'tenant-a',
      clientId: clientHello.clientId,
      accessCredentialId: credentialId,
      authority: 'owner-equivalent' as const,
    };
    return surface === 'desktop-full'
      ? { ...common, transport: 'ssh', surface }
      : { ...common, transport: 'feishu', surface };
  };
}

async function openConnection(
  host: ReturnType<typeof createHost>,
  credentialId: string,
  clientId: string,
  surface: 'desktop-full' | 'feishu-session-console' = 'desktop-full',
) {
  const stream = new TestDuplex();
  const connection = host.accept({
    stream,
    createAccessContext: accessFor(credentialId, surface),
  });
  stream.feed(hello(clientId));
  await waitFor(() => Boolean(findMessage(stream, 'hello-result')), `${clientId} hello`);
  return { connection, stream };
}

describe('daemon credential revocation', () => {
  it('closes an idle subscription and never forwards a later event', async () => {
    const credentials = new CredentialLifecycle();
    const subscriptionState: {
      emit?: Parameters<NonNullable<DaemonCoreRuntime['subscribe']>>[0]['onEvent'];
      signal?: AbortSignal;
    } = {};
    const subscriptionClose = vi.fn(() => undefined);
    const runtime = createRuntime({
      subscribe: async (input) => {
        subscriptionState.emit = input.onEvent;
        subscriptionState.signal = input.signal;
        return { close: subscriptionClose };
      },
    });
    const host = createHost(runtime, {}, undefined, credentials);
    await host.start();
    const { connection, stream } = await openConnection(
      host,
      'credential-a',
      'desktop-a',
    );
    stream.feed({ type: 'subscribe', requestId: 'subscribe-a', afterRevision: 0 });
    await waitFor(() => Boolean(findMessage(stream, 'result', 'subscribe-a')), 'subscription');

    credentials.revoke('credential-a', 'desktop-full');
    await expect(connection.whenClosed()).resolves.toBe('credential-revoked');
    expect(subscriptionState.signal?.aborted).toBe(true);
    expect(subscriptionClose).toHaveBeenCalledOnce();
    expect(findMessage(stream, 'error', 'credential-revoked')).toMatchObject({
      error: { code: 'revoked' },
    });

    const before = stream.decoded().length;
    subscriptionState.emit?.({
      instanceId: 'tenant-a',
      revision: 1,
      kind: 'session.updated',
      entityId: 'session-a',
      payload: {},
    });
    expect(stream.decoded()).toHaveLength(before);
    await host.stop();
  });

  it('aborts in-flight Core execution on a matching push revocation', async () => {
    const credentials = new CredentialLifecycle();
    const requestState: { signal?: AbortSignal } = {};
    const execute = vi.fn(async (input: Parameters<DaemonCoreRuntime['execute']>[0]) => {
      requestState.signal = input.signal;
      return await new Promise<Awaited<ReturnType<DaemonCoreRuntime['execute']>>>((resolve) => {
        input.signal.addEventListener('abort', () => {
          resolve({ result: { aborted: true }, revision: 0 });
        }, { once: true });
      });
    });
    const host = createHost(createRuntime({ execute }), {}, undefined, credentials);
    await host.start();
    const { connection, stream } = await openConnection(host, 'credential-a', 'desktop-a');
    stream.feed(request('slow-request'));
    await waitFor(() => execute.mock.calls.length === 1, 'in-flight request');

    credentials.revoke('credential-a', 'desktop-full');
    await expect(connection.whenClosed()).resolves.toBe('credential-revoked');
    expect(requestState.signal?.aborted).toBe(true);
    await host.stop();
  });

  it('keeps a second credential and the same credential on another surface live', async () => {
    const credentials = new CredentialLifecycle();
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const host = createHost(createRuntime({
      supportedMethods: ['system.health', 'session.console.list'],
      execute,
    }), {}, undefined, credentials);
    await host.start();
    const desktopA = await openConnection(host, 'credential-a', 'desktop-a');
    const desktopB = await openConnection(host, 'credential-b', 'desktop-b');
    const feishuA = await openConnection(
      host,
      'credential-a',
      'feishu-a',
      'feishu-session-console',
    );

    credentials.revoke('credential-a', 'desktop-full');
    await expect(desktopA.connection.whenClosed()).resolves.toBe('credential-revoked');
    expect(desktopB.connection.isClosed).toBe(false);
    expect(feishuA.connection.isClosed).toBe(false);

    desktopB.stream.feed(request('desktop-b-health'));
    feishuA.stream.feed(request('feishu-a-health', 'session.console.list'));
    await waitFor(
      () => Boolean(findMessage(desktopB.stream, 'result', 'desktop-b-health')),
      'second credential request',
    );
    await waitFor(
      () => Boolean(findMessage(feishuA.stream, 'result', 'feishu-a-health')),
      'other surface request',
    );
    await host.stop();
  });

  it('fails closed when revocation races the hello pull and index step', async () => {
    const credentials = new CredentialLifecycle();
    let resolveCheck!: (active: boolean) => void;
    credentials.checkOverride = () => new Promise<boolean>((resolve) => {
      resolveCheck = resolve;
    });
    const host = createHost(createRuntime(), {}, undefined, credentials);
    await host.start();
    const stream = new TestDuplex();
    const connection = host.accept({
      stream,
      createAccessContext: accessFor('credential-race'),
    });
    stream.feed(hello('race-client'));
    await waitFor(() => credentials.checks.length === 1, 'credential pull');

    credentials.revoke('credential-race', 'desktop-full');
    resolveCheck(true);
    await waitFor(
      () => Boolean(findMessage(stream, 'error', 'hello-race-client')),
      'revoked hello error',
    );
    expect(findMessage(stream, 'error', 'hello-race-client')).toMatchObject({
      error: { code: 'revoked' },
    });
    await expect(connection.whenClosed()).resolves.toBe('handshake-rejected');
    await host.stop();
  });

  it('uses pull checks to catch a missed request or subscribe revocation signal', async () => {
    const credentials = new CredentialLifecycle();
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const subscribe = vi.fn(async () => ({ close: () => undefined }));
    const host = createHost(
      createRuntime({ execute, subscribe }),
      {},
      undefined,
      credentials,
    );
    await host.start();
    const requestClient = await openConnection(host, 'credential-request', 'request-client');
    const subscribeClient = await openConnection(host, 'credential-subscribe', 'subscribe-client');
    credentials.deactivate('credential-request', 'desktop-full');
    credentials.deactivate('credential-subscribe', 'desktop-full');

    requestClient.stream.feed(request('missed-request'));
    subscribeClient.stream.feed({
      type: 'subscribe',
      requestId: 'missed-subscribe',
      afterRevision: 0,
    });
    await waitFor(
      () => Boolean(findMessage(requestClient.stream, 'error', 'missed-request')),
      'missed request revoke',
    );
    await waitFor(
      () => Boolean(findMessage(subscribeClient.stream, 'error', 'missed-subscribe')),
      'missed subscribe revoke',
    );
    expect(findMessage(requestClient.stream, 'error', 'missed-request')).toMatchObject({
      error: { code: 'revoked' },
    });
    expect(findMessage(subscribeClient.stream, 'error', 'missed-subscribe')).toMatchObject({
      error: { code: 'revoked' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    await expect(requestClient.connection.whenClosed()).resolves.toBe('credential-revoked');
    await expect(subscribeClient.connection.whenClosed()).resolves.toBe('credential-revoked');
    await host.stop();
  });

  it('ignores a captured provider callback after host stop', async () => {
    const credentials = new CredentialLifecycle();
    const host = createHost(createRuntime(), {}, undefined, credentials);
    await host.start();
    await host.stop();
    credentials.invokeStale('credential-after-stop');
    expect(credentials.close).toHaveBeenCalledOnce();
    expect(host.connectionCount).toBe(0);
  });

  it('removes a normally closed connection from the credential index', async () => {
    const credentials = new CredentialLifecycle();
    const host = createHost(createRuntime(), {}, undefined, credentials);
    await host.start();
    const { connection } = await openConnection(host, 'credential-closed', 'closed-client');
    const revoke = vi.spyOn(connection, 'revokeCredential');
    await connection.shutdown('client-closed');

    credentials.revoke('credential-closed', 'desktop-full');
    expect(revoke).not.toHaveBeenCalled();
    expect(host.connectionCount).toBe(0);
    await host.stop();
  });

  it('joins an in-progress subscription start and unsubscribes exactly once', async () => {
    let resolveSubscription!: (value: { close(): void }) => void;
    const subscriptionState: {
      callback?: (identity: DaemonCredentialIdentity) => void;
    } = {};
    const close = vi.fn(() => undefined);
    const registry = new DaemonCredentialRegistry({
      instanceId: 'tenant-a',
      processId: PROCESS_ID,
      checkTimeoutMs: 10,
      lifecycle: {
        isActive: () => true,
        subscribeRevocations: (listener) => {
          subscriptionState.callback = listener;
          return new Promise((resolve) => { resolveSubscription = resolve; });
        },
      },
    });
    const starting = registry.start();
    const rejectedStart = expect(starting).rejects.toThrow('became stale');
    const stopping = registry.stop();
    resolveSubscription({ close });
    await rejectedStart;
    await stopping;
    expect(close).toHaveBeenCalledOnce();

    subscriptionState.callback?.({
      instanceId: 'tenant-a',
      processId: PROCESS_ID,
      accessCredentialId: 'credential-after-stop',
      accessSurface: 'desktop-full',
    });
    await expect(registry.assertActive(
      'credential-after-stop',
      'desktop-full',
    )).rejects.toMatchObject({ code: 'revoked' });
  });

  it('bounds a stalled authoritative pull and aborts its port signal', async () => {
    vi.useFakeTimers();
    try {
      const checkState: { signal?: AbortSignal } = {};
      const close = vi.fn(() => undefined);
      const registry = new DaemonCredentialRegistry({
        instanceId: 'tenant-a',
        processId: PROCESS_ID,
        checkTimeoutMs: 10,
        lifecycle: {
          isActive: ({ signal }) => {
            checkState.signal = signal;
            return new Promise<boolean>(() => undefined);
          },
          subscribeRevocations: () => ({ close }),
        },
      });
      await registry.start();
      const operation = registry.assertActive('credential-timeout', 'desktop-full');
      const rejected = expect(operation).rejects.toMatchObject({ code: 'revoked' });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(checkState.signal?.aborted).toBe(true);
      await registry.stop();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
