import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => loggerMock } }));

import {
  BrowserUseFrameDecoder,
  encodeBrowserUseFrame,
  type JsonRpcRequest,
} from '../protocol';
import { startBrowserUseServer, type BrowserUseServerHandle } from '../server';

const cleanupPaths: string[] = [];
const handles: BrowserUseServerHandle[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.allSettled(handles.splice(0).map((handle) => handle.shutdown()));
  await Promise.allSettled(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  loggerMock.warn.mockClear();
});

describe('browser-use native-pipe server', () => {
  it('serves framed JSON-RPC responses and notifications, then disposes the connection', async () => {
    const root = await makeTestRoot();
    const pipePath = join(root, 'browser.sock');
    const dispose = vi.fn(async () => {});
    const onError = vi.fn();
    const handle = await startBrowserUseServer({
      pipePath,
      onError,
      createHandler: (notifier) => ({
        handleRequest: vi.fn(async (method, params) => {
          notifier.notify('onCDPEvent', { method: 'Page.loadEventFired' });
          return { method, params };
        }),
        dispose,
      }),
    });
    handles.push(handle);
    const socket = await connect(pipePath);
    sockets.push(socket);

    const messages = readMessages(socket, 2);
    writeRequest(socket, {
      jsonrpc: '2.0',
      id: 19,
      method: 'getInfo',
      params: { session_id: 'session-a' },
    });

    await expect(messages).resolves.toEqual([
      {
        jsonrpc: '2.0',
        method: 'onCDPEvent',
        params: { method: 'Page.loadEventFired' },
      },
      {
        jsonrpc: '2.0',
        id: 19,
        result: {
          method: 'getInfo',
          params: { session_id: 'session-a' },
        },
      },
    ]);
    expect(onError).not.toHaveBeenCalled();

    socket.end();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it('returns handler failures as JSON-RPC errors without dropping the connection', async () => {
    const root = await makeTestRoot();
    const pipePath = join(root, 'browser.sock');
    const handle = await startBrowserUseServer({
      pipePath,
      createHandler: () => ({
        handleRequest: async () => {
          throw new Error('session mismatch');
        },
        dispose: async () => {},
      }),
    });
    handles.push(handle);
    const socket = await connect(pipePath);
    sockets.push(socket);

    const response = readMessages(socket, 1);
    writeRequest(socket, { jsonrpc: '2.0', id: 3, method: 'getInfo' });

    await expect(response).resolves.toEqual([
      {
        jsonrpc: '2.0',
        id: 3,
        error: { code: 1, message: 'Browser request failed.' },
      },
    ]);
    expect(socket.destroyed).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'connection state changed',
      expect.objectContaining({
        operation: 'getInfo',
        reason: 'handler-error',
        requestKind: 'request',
      }),
    );
  });

  it('refuses to replace a live backend and removes its own pipe on shutdown', async () => {
    const root = await makeTestRoot();
    const pipePath = join(root, 'browser.sock');
    const onError = vi.fn();
    const first = await startBrowserUseServer({
      pipePath,
      createHandler: () => ({
        handleRequest: async () => ({}),
        dispose: async () => {},
      }),
    });
    handles.push(first);

    await expect(startBrowserUseServer({ pipePath, onError })).rejects.toMatchObject({
      message: 'Browser server failed to start.',
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(loggerMock.warn).toHaveBeenCalledOnce();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'server state changed',
      expect.objectContaining({ reason: 'server-error' }),
    );

    await first.shutdown();
    handles.splice(handles.indexOf(first), 1);
    await expect(stat(pipePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports one sanitized diagnostic when pipe preparation fails', async () => {
    const root = await makeTestRoot();
    const blocker = join(root, 'private-blocker');
    const pipePath = join(blocker, 'private-browser.sock');
    const onError = vi.fn();
    await writeFile(blocker, 'not a directory');

    await expect(startBrowserUseServer({ pipePath, onError })).rejects.toMatchObject({
      message: 'Browser server failed to start.',
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'browser-transport',
      outcome: 'closed',
      reason: 'server-error',
      runId: expect.any(String),
    }));
    expect(loggerMock.warn).toHaveBeenCalledOnce();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'server state changed',
      expect.objectContaining({ reason: 'server-error' }),
    );
    const diagnostics = JSON.stringify([onError.mock.calls, loggerMock.warn.mock.calls]);
    for (const forbidden of [
      '[browser-transport]',
      'EEXIST',
      'ENOTDIR',
      'not a directory',
      blocker,
      pipePath,
    ]) {
      expect(diagnostics).not.toContain(forbidden);
    }
  });
});

async function makeTestRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-deck-browser-use-'));
  cleanupPaths.push(root);
  return root;
}

async function connect(pipePath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function writeRequest(socket: Socket, request: JsonRpcRequest): void {
  socket.write(encodeBrowserUseFrame(request));
}

async function readMessages(socket: Socket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const decoder = new BrowserUseFrameDecoder();
    const messages: unknown[] = [];
    const onData = (chunk: Buffer): void => {
      try {
        messages.push(...decoder.push(chunk));
        if (messages.length < count) return;
        cleanup();
        resolve(messages);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}
