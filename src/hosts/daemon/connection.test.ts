import {
  AgentDeckClientErrorCode,
  issueRemoteOwnerAccessContext,
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
  it('advertises the complete current capability set and rejects protocol skew', async () => {
    const runtime = createRuntime({
      supportedMethods: [
        'session.console.list', 'usage.tokens.get', 'node.configuration.get', 'node.assets.content',
        'node.assets.catalog.list',
        'session.context.get', 'session.input.capabilities', 'session.handoff.preview',
        'node.hook.projection.get',
        'workspace.directory.create', 'session.archive', 'session.reactivate',
      ],
    });
    const host = createHost(runtime);
    await host.start();
    const current = new TestDuplex();
    host.accept({ stream: current, createAccessContext: sshAccess });
    current.feed(hello('desktop-v2-8', 'full', { major: 2, minor: 8 }));
    await waitFor(() => Boolean(findMessage(current, 'hello-result')), 'current hello-result');
    expect(findMessage(current, 'hello-result')).toMatchObject({
      hello: {
        protocolVersion: { major: 2, minor: 8 },
        capabilities: [
          'session-console.read', 'usage', 'node.configuration', 'node.assets', 'node.assets.bound',
          'sessions.context.read', 'sessions.input.read', 'sessions.handoff',
          'node.hooks.read', 'workspace.directory.write', 'sessions.history.write',
          'sessions.reactivate',
        ],
      },
    });
    const stale = new TestDuplex();
    host.accept({ stream: stale, createAccessContext: sshAccess });
    stale.feed(hello('desktop-v2-6', 'full', { major: 2, minor: 6 }));
    await waitFor(() => Boolean(findMessage(stale, 'error')), 'stale protocol error');
    expect(findMessage(stale, 'error')).toMatchObject({
      error: { code: 'incompatible_protocol' },
    });
    await host.stop();
  });

  it('uses transport-created AccessContext and dispatches hello/request/result/ping', async () => {
    const execute = vi.fn(async (input: Parameters<DaemonCoreRuntime['execute']>[0]) => ({
      result: { observedScope: input.access.connectionScope },
      revision: 7,
    }));
    const runtime = createRuntime({
      supportedMethods: ['session.console.list'],
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
      topology: 'full',
      access: {
        clientId: 'desktop-1',
        connectionScope: 'ssh-credential-1',
        surface: 'desktop',
      },
    });
    expect(helloResult.hello.access).not.toHaveProperty('transportPrivateSecret');
    stream.feed({ type: 'ping', nonce: 'ping-1' });
    stream.feed({
      ...request('list-1', 'session.console.list'),
      params: { accessCredentialId: 'payload-spoof' },
    });
    await waitFor(() => Boolean(findMessage(stream, 'pong')), 'pong');
    await waitFor(() => Boolean(findMessage(stream, 'result', 'list-1')), 'request result');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].access).toMatchObject({
      clientId: 'desktop-1',
      connectionScope: 'ssh-credential-1',
    });
    expect(execute.mock.calls[0][0].access).not.toHaveProperty('transportPrivateSecret');
    expect(execute.mock.calls[0][0].params).toEqual({
      accessCredentialId: 'payload-spoof',
    });
    await host.stop();
  });

  it('enforces the Server-issued Feishu grant after a valid Feishu hello', async () => {
    const runtime = createRuntime({
      supportedMethods: ['system.health', 'session.console.list'],
    });
    const host = createHost(runtime);
    await host.start();
    const stream = new TestDuplex();
    host.accept({
      stream,
      credential: { credentialId: 'feishu-credential-1', surface: 'feishu' },
      createAccessContext: (clientHello) => issueRemoteOwnerAccessContext({
        topology: 'full',
        instanceId: 'tenant-a',
        clientId: clientHello.clientId,
        connectionScope: 'feishu-credential-1',
        surface: 'feishu',
      }),
    });
    stream.feed(hello('chat-1'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'Feishu hello');
    expect(findMessage(stream, 'hello-result')).toMatchObject({
      hello: { capabilities: ['session-console.read'] },
    });
    stream.feed(request('health-1', 'system.health'));
    stream.feed({
      ...request('console-list-1', 'session.console.list'),
      params: { limit: 25 },
    });
    await waitFor(() => Boolean(findMessage(stream, 'error', 'health-1')), 'surface error');
    await waitFor(
      () => Boolean(findMessage(stream, 'result', 'console-list-1')),
      'cwd-free list result',
    );
    expect(findMessage(stream, 'error', 'health-1')).toMatchObject({
      error: { code: 'access_denied' },
    });
    await host.stop();
  });

  it('detaches the admitted claim and rejects channel grants from another surface', async () => {
    const runtime = createRuntime({
      supportedMethods: ['session.console.list', 'system.health'],
    });
    const host = createHost(runtime);
    await host.start();
    const source = issueRemoteOwnerAccessContext({
      topology: 'full',
      instanceId: 'tenant-a',
      clientId: 'desktop-copy',
      connectionScope: 'ssh-credential-1',
      surface: 'desktop',
    });
    const mutableMethods = [...source.grant.productMethods];
    const mutable = {
      ...source,
      grant: {
        ...source.grant,
        productMethods: mutableMethods,
        channelMethods: [...source.grant.channelMethods],
      },
    } as AuthenticatedClientAccessContext;
    const stream = new TestDuplex();
    host.accept({ stream, createAccessContext: () => mutable });
    stream.feed(hello('desktop-copy'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'detached hello');
    mutableMethods.push('system.health');
    stream.feed(request('detached-health', 'system.health'));
    await waitFor(() => Boolean(findMessage(stream, 'error', 'detached-health')), 'grant error');
    expect(findMessage(stream, 'error', 'detached-health')).toMatchObject({
      error: { code: 'access_denied' },
    });

    const mismatched = new TestDuplex();
    const mismatchConnection = host.accept({
      stream: mismatched,
      createAccessContext: (clientHello) => ({
        ...issueRemoteOwnerAccessContext({
          topology: 'full', instanceId: 'tenant-a', clientId: clientHello.clientId,
          connectionScope: 'ssh-credential-1', surface: 'feishu',
        }),
        transport: 'ssh',
        surface: 'desktop',
      } as AuthenticatedClientAccessContext),
    });
    mismatched.feed(hello('desktop-mismatched'));
    await waitFor(() => mismatchConnection.isClosed, 'mismatched grant close');
    expect(findMessage(mismatched, 'error')).toMatchObject({
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

});
