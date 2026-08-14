import { Duplex } from 'node:stream';

import {
  issueRemoteOwnerAccessContext,
  type ClientHello,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import {
  CURRENT_PROTOCOL_VERSION,
  encodeJsonFrame,
  LengthPrefixedJsonDecoder,
} from '@protocol/index';
import { describe, expect, it, vi } from 'vitest';

import { DaemonHost } from './host';
import { resolveDaemonInstancePaths } from './instance-paths';
import { SqliteAbiPreflightError } from './sqlite-preflight';
import type { DaemonCredentialLifecyclePort } from './credential-lifecycle';
import type { DaemonCoreRuntime, DaemonListener } from './types';

class HostTestDuplex extends Duplex {
  readonly writes: Buffer[] = [];

  _read(): void {}

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  feed(value: JsonValue): void {
    this.push(Buffer.from(encodeJsonFrame(value)));
  }

  decoded(): JsonValue[] {
    return new LengthPrefixedJsonDecoder().push(Buffer.concat(this.writes));
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function hello(clientId: string): JsonObject {
  return {
    type: 'hello',
    requestId: `hello-${clientId}`,
    hello: {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      appVersion: 'desktop-test',
      clientId,
      requestedTopology: 'full',
    },
  };
}

function request(requestId: string): JsonObject {
  return {
    type: 'request',
    requestId,
    method: 'session.console.list',
    params: {},
    idempotencyKey: null,
    expectedRevision: null,
    deadlineAt: null,
  };
}

function access(clientHello: ClientHello) {
  return issueRemoteOwnerAccessContext({
    topology: 'full',
    instanceId: 'tenant-a',
    clientId: clientHello.clientId,
    connectionScope: 'ssh-1',
    surface: 'desktop',
  });
}

function hasMessage(stream: HostTestDuplex, type: string, requestId?: string): boolean {
  return stream.decoded().some(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      value.type === type &&
      (requestId === undefined || value.requestId === requestId),
  );
}

const paths = resolveDaemonInstancePaths('tenant-a', {
  HOME: '/srv/agent-deck',
  XDG_RUNTIME_DIR: '/run/user/1200',
});

const DEFAULT_CREDENTIAL = Object.freeze({
  credentialId: 'ssh-1',
  surface: 'desktop' as const,
});

function runtime(): DaemonCoreRuntime {
  return {
    supportedMethods: ['session.console.list'],
    start: async () => undefined,
    stop: async () => undefined,
    currentRevision: () => 0,
    execute: async () => ({ result: { ok: true }, revision: 0 }),
  };
}

function credentialLifecycle(): DaemonCredentialLifecyclePort {
  return {
    isActive: () => true,
    subscribeRevocations: () => ({ close: () => undefined }),
  };
}

describe('daemon host lifecycle', () => {
  it('fails before Core startup when Node-native SQLite preflight fails', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const core = { ...runtime(), start, stop };
    const host = new DaemonHost({
      paths,
      appVersion: 'test',
      runtime: core,
      credentialLifecycle: credentialLifecycle(),
      defaultCredential: DEFAULT_CREDENTIAL,
      listener: null,
      sqlitePreflight: () => {
        throw new SqliteAbiPreflightError('native_load_failed', 'ABI mismatch');
      },
    });

    await expect(host.start()).rejects.toMatchObject({ code: 'native_load_failed' });
    expect(host.state).toBe('stopped');
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops an already-started Core if listener startup fails', async () => {
    const order: string[] = [];
    const start = vi.fn(async () => { order.push('runtime-start'); });
    const stop = vi.fn(async () => { order.push('runtime-stop'); });
    const closeRevocations = vi.fn(() => { order.push('credential-unsubscribe'); });
    const credentials: DaemonCredentialLifecyclePort = {
      isActive: () => true,
      subscribeRevocations: () => {
        order.push('credential-subscribe');
        return { close: closeRevocations };
      },
    };
    const listener: DaemonListener = {
      start: async () => {
        order.push('listener-start');
        throw new Error('listen failed');
      },
      stop: vi.fn(async () => { order.push('listener-stop'); }),
    };
    const host = new DaemonHost({
      paths,
      appVersion: 'test',
      runtime: { ...runtime(), start, stop },
      credentialLifecycle: credentials,
      defaultCredential: DEFAULT_CREDENTIAL,
      listener,
      defaultAccessContextFactory: access,
      sqlitePreflight: () => undefined,
    });

    await expect(host.start()).rejects.toThrow('listen failed');
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith('daemon-start-failed');
    expect(listener.stop).toHaveBeenCalledOnce();
    expect(closeRevocations).toHaveBeenCalledOnce();
    expect(order).toEqual([
      'runtime-start',
      'credential-subscribe',
      'listener-start',
      'credential-unsubscribe',
      'listener-stop',
      'runtime-stop',
    ]);
    expect(host.state).toBe('stopped');
  });

  it('records a post-start listener failure without giving it Core lifecycle ownership', async () => {
    const stop = vi.fn(async () => undefined);
    const failure = new Error('accept loop failed');
    let reportFailure: ((error: Error) => void) | undefined;
    const listener: DaemonListener = {
      start: async (_onConnection, onFailure) => {
        reportFailure = onFailure;
      },
      stop: async () => undefined,
    };
    const host = new DaemonHost({
      paths,
      appVersion: 'test',
      runtime: { ...runtime(), stop },
      credentialLifecycle: credentialLifecycle(),
      defaultCredential: DEFAULT_CREDENTIAL,
      listener,
      defaultAccessContextFactory: access,
      sqlitePreflight: () => undefined,
    });

    await host.start();
    reportFailure?.(failure);
    expect(host.state).toBe('running');
    expect(host.listenerFailure).toBe(failure);
    expect(stop).not.toHaveBeenCalled();
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('awaits request and subscription teardown before Core stop', async () => {
    const order: string[] = [];
    const core = runtime();
    core.execute = async (input) =>
      await new Promise((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            order.push('request-abort');
            setImmediate(() => {
              order.push('request-cleanup');
              resolve({ result: { ok: true }, revision: 0 });
            });
          },
          { once: true },
        );
      });
    core.subscribe = async () => ({
      close: async () => {
        order.push('subscription-close-start');
        await new Promise<void>((resolve) => setImmediate(resolve));
        order.push('subscription-close-end');
      },
    });
    core.stop = async () => {
      order.push('runtime-stop');
    };
    const host = new DaemonHost({
      paths,
      appVersion: 'test',
      runtime: core,
      credentialLifecycle: credentialLifecycle(),
      defaultCredential: DEFAULT_CREDENTIAL,
      listener: null,
      sqlitePreflight: () => undefined,
    });
    await host.start();
    const stream = new HostTestDuplex();
    host.accept({ stream, createAccessContext: access });
    stream.feed(hello('ordered-stop'));
    await waitFor(() => hasMessage(stream, 'hello-result'), 'hello');
    stream.feed(request('slow-request'));
    stream.feed({ type: 'subscribe', requestId: 'subscribe', afterRevision: 0 });
    await waitFor(() => hasMessage(stream, 'result', 'subscribe'), 'subscription');

    await host.stop('ordered-stop');
    expect(order).toEqual([
      'request-abort',
      'request-cleanup',
      'subscription-close-start',
      'subscription-close-end',
      'runtime-stop',
    ]);
  });

  it('waits for connection cleanup during startup rollback before Core stop', async () => {
    const order: string[] = [];
    const core = runtime();
    core.execute = async (input) =>
      await new Promise((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            order.push('rollback-request-abort');
            setImmediate(() => {
              order.push('rollback-request-cleanup');
              resolve({ result: { ok: true }, revision: 0 });
            });
          },
          { once: true },
        );
      });
    core.subscribe = async () => ({
      close: async () => {
        order.push('rollback-subscription-close');
      },
    });
    core.stop = async () => {
      order.push('rollback-runtime-stop');
    };
    const listener: DaemonListener = {
      start: async (onConnection) => {
        const stream = new HostTestDuplex();
        onConnection(stream);
        stream.feed(hello('rollback'));
        await waitFor(() => hasMessage(stream, 'hello-result'), 'rollback hello');
        stream.feed(request('rollback-request'));
        stream.feed({ type: 'subscribe', requestId: 'rollback-subscribe', afterRevision: 0 });
        await waitFor(
          () => hasMessage(stream, 'result', 'rollback-subscribe'),
          'rollback subscription',
        );
        throw new Error('post-accept listener failure');
      },
      stop: async () => undefined,
    };
    const host = new DaemonHost({
      paths,
      appVersion: 'test',
      runtime: core,
      credentialLifecycle: credentialLifecycle(),
      defaultCredential: DEFAULT_CREDENTIAL,
      listener,
      defaultAccessContextFactory: access,
      sqlitePreflight: () => undefined,
    });

    await expect(host.start()).rejects.toThrow('post-accept listener failure');
    expect(order).toEqual([
      'rollback-request-abort',
      'rollback-request-cleanup',
      'rollback-subscription-close',
      'rollback-runtime-stop',
    ]);
    expect(host.connectionCount).toBe(0);
  });

  it('reports connection cleanup failure only after still stopping Core', async () => {
    const order: string[] = [];
    const core = runtime();
    core.subscribe = async () => ({
      close: async () => {
        order.push('subscription-close-failed');
        throw new Error('subscription cleanup failed');
      },
    });
    core.stop = async () => {
      order.push('runtime-stop');
    };
    const host = new DaemonHost({
      paths,
      appVersion: 'test',
      runtime: core,
      credentialLifecycle: credentialLifecycle(),
      defaultCredential: DEFAULT_CREDENTIAL,
      listener: null,
      sqlitePreflight: () => undefined,
    });
    await host.start();
    const stream = new HostTestDuplex();
    host.accept({ stream, createAccessContext: access });
    stream.feed(hello('cleanup-failure'));
    await waitFor(() => hasMessage(stream, 'hello-result'), 'hello');
    stream.feed({ type: 'subscribe', requestId: 'subscribe', afterRevision: 0 });
    await waitFor(() => hasMessage(stream, 'result', 'subscribe'), 'subscription');

    await expect(host.stop('cleanup-failure')).rejects.toThrow(
      'Daemon host shutdown failed',
    );
    expect(order).toEqual(['subscription-close-failed', 'runtime-stop']);
    expect(host.state).toBe('stopped');
  });
});
