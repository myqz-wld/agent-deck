import {
  AgentDeckClientErrorCode,
  type AgentDeckEventEnvelope,
  type AuthenticatedClientAccessContext,
} from '@contracts/index';
import { describe, expect, it, vi } from 'vitest';

import {
  createHost,
  createRuntime,
  findMessage,
  hello,
  request,
  sshAccess,
  TestDuplex,
  waitFor,
} from './connection-test-helpers';
import { DaemonRequestError, type DaemonCoreRuntime } from './types';

describe('daemon framed connection', () => {
  it('uses transport-created AccessContext and dispatches hello/request/result/ping', async () => {
    const execute = vi.fn(async (input: Parameters<DaemonCoreRuntime['execute']>[0]) => ({
      result: { observedCredential: input.access.accessCredentialId },
      revision: 7,
    }));
    const runtime = createRuntime({
      supportedMethods: ['session.list'],
      currentRevision: () => 6,
      execute,
    });
    const host = createHost(runtime);
    await host.start();
    const stream = new TestDuplex();
    host.accept({
      stream,
      createAccessContext: (clientHello) =>
        ({
          ...sshAccess(clientHello),
          transportPrivateSecret: 'must-not-cross-the-wire',
        }) as unknown as AuthenticatedClientAccessContext,
    });

    stream.feed(hello('desktop-1'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'hello-result');
    const helloResult = findMessage(stream, 'hello-result') as unknown as {
      hello: { access: AuthenticatedClientAccessContext; topology: string };
    };
    expect(helloResult.hello).toMatchObject({
      topology: 'server-core',
      access: {
        clientId: 'desktop-1',
        accessCredentialId: 'ssh-credential-1',
        surface: 'desktop-full',
      },
    });
    expect(helloResult.hello.access).not.toHaveProperty('transportPrivateSecret');

    stream.feed({ type: 'ping', nonce: 'ping-1' });
    stream.feed({
      ...request('list-1', 'session.list'),
      params: { accessCredentialId: 'payload-spoof' },
    });
    await waitFor(() => Boolean(findMessage(stream, 'pong')), 'pong');
    await waitFor(() => Boolean(findMessage(stream, 'result', 'list-1')), 'request result');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].access).toMatchObject({
      clientId: 'desktop-1',
      accessCredentialId: 'ssh-credential-1',
    });
    expect(execute.mock.calls[0][0].access).not.toHaveProperty('transportPrivateSecret');
    expect(execute.mock.calls[0][0].params).toEqual({
      accessCredentialId: 'payload-spoof',
    });
    await host.stop();
  });

  it('enforces the fixed Feishu method surface after a valid Feishu hello', async () => {
    const runtime = createRuntime({
      supportedMethods: ['system.health', 'session.list', 'session.console.list'],
    });
    const host = createHost(runtime);
    await host.start();
    const stream = new TestDuplex();
    host.accept({
      stream,
      createAccessContext: (clientHello) => ({
        kind: 'authenticated-client',
        topology: 'server-core',
        instanceId: 'tenant-a',
        clientId: clientHello.clientId,
        transport: 'feishu',
        accessCredentialId: 'feishu-credential-1',
        authority: 'owner-equivalent',
        surface: 'feishu-session-console',
      }),
    });
    stream.feed(hello('chat-1'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'Feishu hello');
    expect(findMessage(stream, 'hello-result')).toMatchObject({
      hello: { capabilities: ['session-console.read'] },
    });
    stream.feed(request('health-1'));
    stream.feed(request('legacy-list-1', 'session.list'));
    stream.feed({
      ...request('console-list-1', 'session.console.list'),
      params: { limit: 25 },
    });
    await waitFor(() => Boolean(findMessage(stream, 'error', 'health-1')), 'surface error');
    await waitFor(
      () => Boolean(findMessage(stream, 'error', 'legacy-list-1')),
      'legacy surface error',
    );
    await waitFor(
      () => Boolean(findMessage(stream, 'result', 'console-list-1')),
      'cwd-free list result',
    );
    expect(findMessage(stream, 'error', 'health-1')).toMatchObject({
      error: { code: 'access_denied' },
    });
    expect(findMessage(stream, 'error', 'legacy-list-1')).toMatchObject({
      error: { code: 'access_denied' },
    });
    await host.stop();
  });

  it('rejects incompatible topology and malformed frames without stopping Core', async () => {
    const stop = vi.fn(async () => undefined);
    const runtime = createRuntime({ stop });
    const host = createHost(runtime);
    await host.start();

    const incompatible = new TestDuplex();
    const incompatibleConnection = host.accept({
      stream: incompatible,
      createAccessContext: sshAccess,
    });
    incompatible.feed(hello('desktop-wrong', 'relay'));
    await waitFor(() => incompatibleConnection.isClosed, 'incompatible close');
    expect(findMessage(incompatible, 'error')).toMatchObject({
      error: { code: 'incompatible_protocol' },
    });

    const malformed = new TestDuplex();
    const malformedConnection = host.accept({ stream: malformed, createAccessContext: sshAccess });
    malformed.feedBytes(new Uint8Array([0, 0, 0, 0]));
    await waitFor(() => malformedConnection.isClosed, 'malformed close');
    expect(stop).not.toHaveBeenCalled();
    expect(host.state).toBe('running');
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('makes handshake rejection terminal before a coalesced request can dispatch', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const subscribe = vi.fn(async () => ({ close: () => undefined }));
    const runtime = createRuntime({
      execute,
      subscribe,
      currentRevision: () => {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.InvalidRequest,
          'revision unavailable',
        );
      },
    });
    const host = createHost(runtime, { protocolCloseGraceMs: 1_000 });
    await host.start();
    const stream = new TestDuplex();
    const connection = host.accept({ stream, createAccessContext: sshAccess });
    stream.setWriteBlocked(true);

    stream.feedMany([
      hello('terminal-handshake'),
      request('must-not-run'),
      { type: 'subscribe', requestId: 'must-not-subscribe', afterRevision: 0 },
    ]);
    await waitFor(
      () => connection.state === 'terminal-flushing',
      'terminal handshake state',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    stream.setWriteBlocked(false);
    await connection.whenClosed();

    expect(findMessage(stream, 'error', 'hello-terminal-handshake')).toMatchObject({
      error: { code: 'invalid_request' },
    });
    await host.stop();
  });

  it('makes duplicate hello terminal before later request or subscribe dispatch', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const subscribe = vi.fn(async () => ({ close: () => undefined }));
    const host = createHost(
      createRuntime({ execute, subscribe }),
      { protocolCloseGraceMs: 1_000 },
    );
    await host.start();
    const stream = new TestDuplex();
    const connection = host.accept({ stream, createAccessContext: sshAccess });
    stream.feed(hello('first-hello'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'first hello');
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.setWriteBlocked(true);

    stream.feedMany([
      hello('duplicate-hello'),
      request('must-not-run'),
      { type: 'subscribe', requestId: 'must-not-subscribe', afterRevision: 0 },
    ]);
    await waitFor(() => connection.state === 'terminal-flushing', 'duplicate terminal state');
    expect(execute).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    stream.setWriteBlocked(false);
    await connection.whenClosed();

    expect(findMessage(stream, 'error', 'hello-duplicate-hello')).toMatchObject({
      error: { code: 'invalid_request' },
    });
    await host.stop();
  });

  it('treats ordinary transport disconnect as connection teardown, not Core shutdown', async () => {
    const stop = vi.fn(async () => undefined);
    const runtime = createRuntime({ stop });
    const host = createHost(runtime);
    await host.start();
    const stream = new TestDuplex();
    const connection = host.accept({ stream, createAccessContext: sshAccess });
    stream.feed(hello('desktop-disconnect'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'hello');

    stream.push(null);
    await connection.whenClosed();
    expect(host.state).toBe('running');
    expect(host.connectionCount).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    await host.stop('operator-stop');
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith('operator-stop');
  });

  it('emits one cancelled terminal response and suppresses a late executor result', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseExecutor!: () => void;
    const runtime = createRuntime({
      execute: async (input) => {
        observedSignal = input.signal;
        await new Promise<void>((resolve) => {
          releaseExecutor = resolve;
        });
        return { result: { late: true }, revision: 1 };
      },
    });
    const host = createHost(runtime);
    await host.start();
    const stream = new TestDuplex();
    host.accept({ stream, createAccessContext: sshAccess });
    stream.feed(hello('desktop-cancel'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'hello');
    stream.feed(request('slow-request'));
    await waitFor(() => Boolean(observedSignal), 'executor signal');
    stream.feed({ type: 'cancel', requestId: 'cancel-1', targetRequestId: 'slow-request' });
    await waitFor(() => observedSignal?.aborted === true, 'abort propagation');
    await waitFor(() => Boolean(findMessage(stream, 'error', 'slow-request')), 'cancel response');
    expect(findMessage(stream, 'error', 'slow-request')).toMatchObject({
      error: { code: 'cancelled', retryable: false },
    });
    releaseExecutor();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(findMessage(stream, 'result', 'slow-request')).toBeUndefined();
    expect(
      stream
        .decoded()
        .filter(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            !Array.isArray(message) &&
            message.type === 'error' &&
            message.requestId === 'slow-request',
        ),
    ).toHaveLength(1);
    await host.stop();
  });

  it('returns a redacted internal error without closing the healthy connection', async () => {
    const runtime = createRuntime({
      execute: async (input) => {
        if (input.requestId === 'broken-request') {
          throw new Error('sensitive executor detail');
        }
        return { result: { ok: true }, revision: 2 };
      },
    });
    const host = createHost(runtime);
    await host.start();
    const stream = new TestDuplex();
    const connection = host.accept({ stream, createAccessContext: sshAccess });
    stream.feed(hello('desktop-internal-error'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'hello');

    stream.feed(request('broken-request'));
    await waitFor(() => Boolean(findMessage(stream, 'error', 'broken-request')), 'internal error');
    expect(findMessage(stream, 'error', 'broken-request')).toMatchObject({
      error: {
        code: 'internal_error',
        message: 'Core request failed',
        retryable: false,
      },
    });
    expect(JSON.stringify(findMessage(stream, 'error', 'broken-request'))).not.toContain(
      'sensitive executor detail',
    );
    expect(connection.isClosed).toBe(false);

    stream.feed(request('healthy-after-error'));
    await waitFor(
      () => Boolean(findMessage(stream, 'result', 'healthy-after-error')),
      'healthy result',
    );
    await host.stop();
  });

  it('isolates bounded request queues so one abnormal client cannot block another', async () => {
    const runtime = createRuntime({
      execute: async (input) => {
        if (input.requestId === 'slow-1') {
          await new Promise<never>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        }
        return { result: { requestId: input.requestId }, revision: 1 };
      },
    });
    const host = createHost(runtime, { maxConcurrentRequests: 1, maxQueuedRequests: 1 });
    await host.start();
    const slow = new TestDuplex();
    const healthy = new TestDuplex(1024 * 1024);
    const slowConnection = host.accept({ stream: slow, createAccessContext: sshAccess });
    const healthyConnection = host.accept({ stream: healthy, createAccessContext: sshAccess });
    slow.feed(hello('desktop-slow'));
    healthy.feed(hello('desktop-healthy'));
    await waitFor(() => Boolean(findMessage(slow, 'hello-result')), 'slow hello');
    await waitFor(() => Boolean(findMessage(healthy, 'hello-result')), 'healthy hello');

    slow.feed(request('slow-1'));
    slow.feed(request('queued-1'));
    slow.feed(request('overflow-1'));
    await waitFor(() => slowConnection.isClosed, 'queue overflow close');
    expect(healthyConnection.isClosed).toBe(false);
    healthy.feed(request('healthy-1'));
    await waitFor(() => Boolean(findMessage(healthy, 'result', 'healthy-1')), 'healthy result');
    expect(host.connectionCount).toBe(1);
    await host.stop();
  });

  it('isolates an outbound byte-queue overflow to the slow connection', async () => {
    const runtime = createRuntime({
      execute: async (input) => ({
        result: { requestId: input.requestId, payload: 'x'.repeat(1_500) },
        revision: 1,
      }),
    });
    const host = createHost(runtime, { maxQueuedBytes: 2_048 });
    await host.start();
    const slow = new TestDuplex();
    const healthy = new TestDuplex(1024 * 1024);
    const slowConnection = host.accept({ stream: slow, createAccessContext: sshAccess });
    const healthyConnection = host.accept({ stream: healthy, createAccessContext: sshAccess });
    slow.feed(hello('byte-slow'));
    healthy.feed(hello('byte-healthy'));
    await waitFor(() => Boolean(findMessage(slow, 'hello-result')), 'slow hello');
    await waitFor(() => Boolean(findMessage(healthy, 'hello-result')), 'healthy hello');
    await new Promise<void>((resolve) => setImmediate(resolve));
    slow.setWriteBlocked(true);

    slow.feedMany([request('byte-1'), request('byte-2')]);
    await expect(slowConnection.whenClosed()).resolves.toBe(
      'outbound-byte-queue-overflow',
    );
    expect(healthyConnection.isClosed).toBe(false);

    healthy.feed(request('healthy-byte-result'));
    await waitFor(
      () => Boolean(findMessage(healthy, 'result', 'healthy-byte-result')),
      'healthy byte result',
    );
    slow.setWriteBlocked(false);
    await host.stop();
  });

  it('bounds slow event consumers while continuing fanout to healthy connections', async () => {
    const eventListeners = new Map<string, (event: AgentDeckEventEnvelope) => void>();
    let revision = 0;
    const runtime = createRuntime({
      currentRevision: () => revision,
      subscribe: async ({ access, onEvent }) => {
        eventListeners.set(access.clientId, onEvent);
        return {
          close: () => {
            eventListeners.delete(access.clientId);
          },
        };
      },
    });
    const host = createHost(runtime, { maxQueuedEvents: 2, maxQueuedFrames: 4 });
    await host.start();
    const slow = new TestDuplex();
    const healthy = new TestDuplex(1024 * 1024);
    const slowConnection = host.accept({ stream: slow, createAccessContext: sshAccess });
    const healthyConnection = host.accept({ stream: healthy, createAccessContext: sshAccess });
    slow.feed(hello('events-slow'));
    healthy.feed(hello('events-healthy'));
    await waitFor(() => Boolean(findMessage(slow, 'hello-result')), 'slow hello');
    await waitFor(() => Boolean(findMessage(healthy, 'hello-result')), 'healthy hello');
    slow.feed({ type: 'subscribe', requestId: 'sub-slow', afterRevision: 0 });
    healthy.feed({ type: 'subscribe', requestId: 'sub-healthy', afterRevision: 0 });
    await waitFor(() => Boolean(findMessage(slow, 'result', 'sub-slow')), 'slow subscribe');
    await waitFor(() => Boolean(findMessage(healthy, 'result', 'sub-healthy')), 'healthy subscribe');
    await new Promise<void>((resolve) => setImmediate(resolve));
    slow.setWriteBlocked(true);

    for (revision = 1; revision <= 4; revision += 1) {
      for (const listener of [...eventListeners.values()]) {
        listener({
          instanceId: 'tenant-a',
          revision,
          kind: 'session.updated',
          entityId: 'session-1',
          payload: { revision },
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await waitFor(() => slowConnection.isClosed, 'slow event close');
    await waitFor(
      () => healthy.decoded().filter((value) => (value as { type?: string }).type === 'event').length === 4,
      'healthy event fanout',
    );
    expect(healthyConnection.isClosed).toBe(false);
    slow.setWriteBlocked(false);
    await host.stop();
  });
});
