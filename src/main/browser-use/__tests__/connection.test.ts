import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { endianness } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => loggerMock } }));

import {
  BrowserUseFrameDecoder,
  encodeBrowserUseFrame,
  type JsonRpcRequest,
} from '../protocol';
import {
  BrowserUseConnection,
  type BrowserUseRequestHandler,
} from '../server';

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly writes: Buffer[] = [];
  readonly writeResults: boolean[] = [];

  write(frame: Uint8Array): boolean {
    const copy = Buffer.from(frame);
    this.writes.push(copy);
    const accepted = this.writeResults.shift() ?? true;
    if (!accepted) this.writableLength += copy.byteLength;
    return accepted;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  receive(...requests: JsonRpcRequest[]): void {
    this.emit('data', Buffer.concat(requests.map((request) => encodeBrowserUseFrame(request))));
  }

  receiveBytes(bytes: Buffer): void {
    this.emit('data', bytes);
  }

  drain(): void {
    this.writableLength = 0;
    this.emit('drain');
  }
}

afterEach(() => {
  loggerMock.warn.mockClear();
  vi.useRealTimers();
});

describe('BrowserUseConnection resource bounds', () => {
  it('allows bounded concurrent work and preserves completion-order response ids', async () => {
    const first = deferred<unknown>();
    const handler = makeHandler(async (_method, params) => {
      return params === 'first' ? first.promise : 'second-result';
    });
    const { socket } = makeConnection(handler, { maxInflightRequests: 2 });

    socket.receive(
      { jsonrpc: '2.0', id: 1, method: 'work', params: 'first' },
      { jsonrpc: '2.0', id: 2, method: 'work', params: 'second' },
    );
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
    expect(decodeWrites(socket)).toEqual([
      { jsonrpc: '2.0', id: 2, result: 'second-result' },
    ]);

    first.resolve('first-result');
    await vi.waitFor(() => expect(socket.writes).toHaveLength(2));
    expect(decodeWrites(socket)).toEqual([
      { jsonrpc: '2.0', id: 2, result: 'second-result' },
      { jsonrpc: '2.0', id: 1, result: 'first-result' },
    ]);
  });

  it('dispatches and echoes a null JSON-RPC id', async () => {
    const handler = makeHandler(async () => 'null-id-result');
    const { socket } = makeConnection(handler);

    socket.receive({ jsonrpc: '2.0', id: null, method: 'work' });
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1));

    expect(handler.handleRequest).toHaveBeenCalledWith('work', undefined);
    expect(decodeWrites(socket)).toEqual([
      { jsonrpc: '2.0', id: null, result: 'null-id-result' },
    ]);
    expect(socket.destroyed).toBe(false);
  });

  it('closes on an object JSON-RPC id without exposing it', async () => {
    const rawMarker = 'private-object-id';
    const handler = makeHandler(async () => 'unexpected');
    const onError = vi.fn();
    const { socket } = makeConnection(handler, {}, onError);

    socket.receiveBytes(encodeBrowserUseFrame({
      jsonrpc: '2.0',
      id: { marker: rawMarker },
      method: 'work',
    }));
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));

    expect(handler.handleRequest).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'browser-transport',
      outcome: 'closed',
      reason: 'invalid-request',
    }));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'connection state changed',
      expect.objectContaining({ reason: 'invalid-request' }),
    );
    expect(JSON.stringify([onError.mock.calls, loggerMock.warn.mock.calls]))
      .not.toContain(rawMarker);
  });

  it('rejects requests above the inflight cap without invoking the handler', async () => {
    const first = deferred<unknown>();
    const handler = makeHandler(async () => first.promise);
    const { socket } = makeConnection(handler, { maxInflightRequests: 1 });

    socket.receive(
      { jsonrpc: '2.0', id: 1, method: 'work' },
      { jsonrpc: '2.0', id: 2, method: 'work' },
    );
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
    expect(decodeWrites(socket)).toEqual([
      {
        jsonrpc: '2.0',
        id: 2,
        error: {
          code: -32001,
          message: 'Browser transport resource limit exceeded.',
        },
      },
    ]);
    expect(handler.handleRequest).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(false);

    first.resolve('done');
    await vi.waitFor(() => expect(socket.writes).toHaveLength(2));
  });

  it('closes on an oversized frame header before dispatching a payload', async () => {
    const handler = makeHandler(async () => ({}));
    const onError = vi.fn();
    const { socket } = makeConnection(handler, { maxFrameBytes: 16 }, onError);
    const header = Buffer.alloc(4);
    if (endianness() === 'LE') header.writeUInt32LE(17, 0);
    else header.writeUInt32BE(17, 0);

    socket.receiveBytes(header);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(handler.handleRequest).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'browser-transport',
      outcome: 'closed',
      reason: 'input-frame-limit',
      runId: expect.any(String),
    }));
  });

  it('closes instead of encoding an oversized response', async () => {
    const rawMarker = 'must-not-escape-output-limit';
    const handler = makeHandler(async () => ({ data: rawMarker.repeat(64) }));
    const onError = vi.fn();
    const { socket } = makeConnection(
      handler,
      { maxOutputFrameBytes: 128 },
      onError,
    );

    socket.receive({ jsonrpc: '2.0', id: 1, method: 'work' });
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(socket.writes).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'browser-transport',
      outcome: 'closed',
      reason: 'output-frame-limit',
      runId: expect.any(String),
    }));
    expect(JSON.stringify(onError.mock.calls)).not.toContain(rawMarker);
  });

  it('queues bounded output after write(false) and flushes it on drain', async () => {
    const handler = makeHandler(async () => 'response');
    const { socket, notifier } = makeConnection(handler, {
      maxQueuedOutputBytes: 2_048,
    });
    socket.writeResults.push(false, true, true);

    notifier.notify('first', { order: 1 });
    notifier.notify('second', { order: 2 });
    socket.receive({ jsonrpc: '2.0', id: 3, method: 'work' });
    await vi.waitFor(() => expect(handler.handleRequest).toHaveBeenCalledOnce());
    expect(socket.writes).toHaveLength(1);

    socket.drain();
    await vi.waitFor(() => expect(socket.writes).toHaveLength(3));
    expect(decodeWrites(socket)).toEqual([
      { jsonrpc: '2.0', method: 'first', params: { order: 1 } },
      { jsonrpc: '2.0', method: 'second', params: { order: 2 } },
      { jsonrpc: '2.0', id: 3, result: 'response' },
    ]);
  });

  it('closes when a slow reader exceeds the queued-byte cap', async () => {
    const handler = makeHandler(async () => 'x'.repeat(160));
    const onError = vi.fn();
    const { socket, notifier } = makeConnection(
      handler,
      {
        maxOutputFrameBytes: 512,
        maxQueuedOutputBytes: 220,
      },
      onError,
    );
    socket.writeResults.push(false);

    notifier.notify('blocked', { value: 'x'.repeat(80) });
    socket.receive({ jsonrpc: '2.0', id: 4, method: 'work' });
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'browser-transport',
      outcome: 'closed',
      reason: 'output-queue-limit',
    }));
  });

  it('closes a blocked writer at the drain deadline', async () => {
    vi.useFakeTimers();
    const handler = makeHandler(async () => ({}));
    const onError = vi.fn();
    const { socket, notifier } = makeConnection(
      handler,
      { drainTimeoutMs: 25 },
      onError,
    );
    socket.writeResults.push(false);

    notifier.notify('blocked', {});
    expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(26);

    expect(socket.destroyed).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'browser-transport',
      outcome: 'closed',
      reason: 'drain-timeout',
    }));
    expect(handler.dispose).toHaveBeenCalledOnce();
  });

  it('returns fixed handler errors without forwarding raw exception text', async () => {
    const rawMarker = 'https://private.test/?token=secret /private/path page-payload';
    const handler = makeHandler(async () => {
      throw new Error(rawMarker);
    });
    const onError = vi.fn();
    const { socket } = makeConnection(handler, {}, onError);

    socket.receive({ jsonrpc: '2.0', id: 5, method: 'work' });
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
    expect(decodeWrites(socket)).toEqual([
      {
        jsonrpc: '2.0',
        id: 5,
        error: { code: 1, message: 'Browser request failed.' },
      },
    ]);
    expect(JSON.stringify(onError.mock.calls)).not.toContain(rawMarker);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'connection state changed',
      expect.objectContaining({ reason: 'handler-error' }),
    );
    expect(JSON.stringify(loggerMock.warn.mock.calls)).not.toContain('[browser-transport]');
    expect(JSON.stringify(loggerMock.warn.mock.calls)).not.toContain(rawMarker);
  });
});

function makeConnection(
  handler: BrowserUseRequestHandler,
  limits: Record<string, number> = {},
  onError = vi.fn(),
): {
  connection: BrowserUseConnection;
  notifier: { notify(method: string, params: unknown): void };
  socket: FakeSocket;
} {
  const socket = new FakeSocket();
  let notifier: { notify(method: string, params: unknown): void } | null = null;
  const connection = new BrowserUseConnection({
    socket: socket as unknown as Socket,
    createHandler: (candidate) => {
      notifier = candidate;
      return handler;
    },
    limits,
    onClosed: vi.fn(),
    onError,
  });
  if (notifier == null) throw new Error('expected notifier');
  return { connection, notifier, socket };
}

function makeHandler(
  handleRequest: (method: string, params: unknown) => Promise<unknown>,
): BrowserUseRequestHandler {
  return {
    handleRequest: vi.fn(handleRequest),
    dispose: vi.fn(async () => {}),
  };
}

function decodeWrites(socket: FakeSocket): unknown[] {
  const decoder = new BrowserUseFrameDecoder();
  return socket.writes.flatMap((frame) => decoder.push(frame));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((candidate) => {
    resolve = candidate;
  });
  return { promise, resolve };
}
