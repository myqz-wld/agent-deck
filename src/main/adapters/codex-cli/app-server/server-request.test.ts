import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from './client';

interface FakeChild {
  stdin: { write: ReturnType<typeof vi.fn> };
  killed: boolean;
}

function harness() {
  const writes: string[] = [];
  const child: FakeChild = {
    stdin: {
      write: vi.fn((value: string) => {
        writes.push(value);
        return true;
      }),
    },
    killed: true,
  };
  const client = new CodexAppServerClient({ env: {}, config: null });
  const internal = client as unknown as {
    child: FakeChild | null;
    handleLine: (sourceChild: FakeChild, raw: string) => void;
  };
  internal.child = child;
  return { client, child, writes, handleLine: internal.handleLine.bind(client) };
}

function parsedWrites(writes: string[]): unknown[] {
  return writes.map((line) => JSON.parse(line));
}

describe('CodexAppServerClient server requests', () => {
  it('routes an app-server request through the host handler and writes its JSON-RPC result', async () => {
    const { client, child, writes, handleLine } = harness();
    client.setServerRequestHandler(async (request) => ({
      handled: true,
      result: { decision: request.method === 'approval' ? 'accept' : 'decline' },
    }));

    handleLine(child, JSON.stringify({ id: 41, method: 'approval', params: { value: 1 } }));

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(parsedWrites(writes)).toEqual([
      { id: 41, result: { decision: 'accept' } },
    ]);
  });

  it('returns method-not-found for a server request the host does not handle', async () => {
    const { client, child, writes, handleLine } = harness();
    client.setServerRequestHandler(() => ({ handled: false }));

    handleLine(child, JSON.stringify({ id: 'unsupported-1', method: 'unknown/request' }));

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(parsedWrites(writes)).toEqual([
      {
        id: 'unsupported-1',
        error: {
          code: -32601,
          message: 'Unsupported server request: unknown/request',
        },
      },
    ]);
  });

  it('aborts the host callback after serverRequest/resolved and suppresses a late response', async () => {
    const { client, child, writes, handleLine } = harness();
    let observedSignal: AbortSignal | null = null;
    client.setServerRequestHandler((_request, signal) => {
      observedSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => resolve({ handled: true, result: { decision: 'cancel' } }),
          { once: true },
        );
      });
    });

    handleLine(child, JSON.stringify({ id: 42, method: 'approval' }));
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    handleLine(child, JSON.stringify({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 42 },
    }));

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(writes).toEqual([]);
  });

  it('serializes a host callback failure as a bounded JSON-RPC error', async () => {
    const { client, child, writes, handleLine } = harness();
    client.setServerRequestHandler(() => {
      throw new Error('approval bridge failed');
    });

    handleLine(child, JSON.stringify({ id: 43, method: 'approval' }));

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(parsedWrites(writes)).toEqual([
      {
        id: 43,
        error: { code: -32000, message: 'approval bridge failed' },
      },
    ]);
  });
});
