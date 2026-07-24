import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { requestCodexRaw, type CodexPendingRequest } from './request-raw';

function makeChild(writes: string[]): ChildProcessWithoutNullStreams {
  const write = vi.fn((value: string, callback?: (error?: Error | null) => void) => {
    writes.push(value);
    callback?.();
    return true;
  });
  return { stdin: { write } } as unknown as ChildProcessWithoutNullStreams;
}

describe('requestCodexRaw', () => {
  it('sends JSON-RPC cancellation when the request signal aborts', async () => {
    const writes: string[] = [];
    const pending = new Map<number | string, CodexPendingRequest>();
    const controller = new AbortController();
    const request = requestCodexRaw({
      child: makeChild(writes),
      pending,
      id: 7,
      method: 'turn/steer',
      params: { threadId: 'thread-1', expectedTurnId: 'turn-1' },
      signal: controller.signal,
    });

    expect(JSON.parse(writes[0]!)).toEqual({
      method: 'turn/steer',
      id: 7,
      params: { threadId: 'thread-1', expectedTurnId: 'turn-1' },
    });
    expect(pending.has(7)).toBe(true);

    controller.abort();

    await expect(request).rejects.toThrow('Codex request cancelled');
    expect(pending.has(7)).toBe(false);
    expect(JSON.parse(writes[1]!)).toEqual({
      method: '$/cancel_request',
      params: { id: 7 },
    });
  });

  it('does not send cancellation after the response has settled', async () => {
    const writes: string[] = [];
    const pending = new Map<number | string, CodexPendingRequest>();
    const controller = new AbortController();
    const request = requestCodexRaw({
      child: makeChild(writes),
      pending,
      id: 8,
      method: 'turn/steer',
      params: {},
      signal: controller.signal,
    });

    pending.get(8)!.resolve({ accepted: true });
    await expect(request).resolves.toEqual({ accepted: true });

    controller.abort();
    expect(writes).toHaveLength(1);
  });
});
