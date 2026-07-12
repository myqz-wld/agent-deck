import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { sessionManager } from '@main/session/manager';
import { MockSdkQuery } from '@main/__tests__/_shared/mocks/sdk-query';
import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { StreamProcessor } from '../stream-processor';
import { makeInternalSession } from '../types';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => null),
    setPermissionMode: vi.fn(),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
  },
}));

async function waitForNotify(
  internal: ReturnType<typeof makeInternalSession>,
  previous?: () => void,
): Promise<() => void> {
  let notify: (() => void) | null = null;
  await vi.waitFor(() => {
    notify = internal.notify;
    expect(notify).toBeTypeOf('function');
    if (previous) expect(notify).not.toBe(previous);
  });
  return notify!;
}

function pendingMessage(text: string, materialized: ReturnType<typeof vi.fn>) {
  return async (): Promise<SDKUserMessage> => {
    materialized();
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      priority: 'now',
      session_id: 'source-sid',
    };
  };
}

describe('StreamProcessor deferred handoff retirement', () => {
  it('feeds ordinary queued turns one at a time and releases the next only after result', async () => {
    const internal = makeInternalSession({
      cwd: '/tmp/claude-serialized-input',
      applicationSid: 'source-sid',
    });
    const query = new MockSdkQuery();
    internal.query = query as unknown as Query;
    const firstMaterialized = vi.fn();
    const secondMaterialized = vi.fn();
    internal.pendingUserMessages.push(
      pendingMessage('turn one', firstMaterialized),
      pendingMessage('turn two', secondMaterialized),
    );
    const sessions = new Map([['source-sid', internal]]);
    const processor = new StreamProcessor({ sessions, emit: () => undefined });
    const stream = processor.createUserMessageStream(internal, 'source-sid')[
      Symbol.asyncIterator
    ]();

    await expect(stream.next()).resolves.toMatchObject({ done: false });
    expect(firstMaterialized).toHaveBeenCalledOnce();
    const second = stream.next();
    await waitForNotify(internal);
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(secondMaterialized).not.toHaveBeenCalled();

    const consume = processor.consume(internal, 'source-sid', () => undefined);
    query.pushFrame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'turn one complete',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    await expect(second).resolves.toMatchObject({ done: false });
    expect(secondMaterialized).toHaveBeenCalledOnce();
    query.endStream();
    await consume;
  });

  it('keeps a waiting input stream alive until the result boundary without yielding new input', async () => {
    const internal = makeInternalSession({
      cwd: '/tmp/claude-retirement-wait',
      applicationSid: 'source-sid',
    });
    const sessions = new Map([['source-sid', internal]]);
    const processor = new StreamProcessor({ sessions, emit: () => undefined });
    const stream = processor.createUserMessageStream(internal, 'source-sid')[
      Symbol.asyncIterator
    ]();

    let settled = false;
    const next = stream.next().finally(() => {
      settled = true;
    });
    const initialNotify = await waitForNotify(internal);

    internal.retireRequested = true;
    await Promise.resolve();
    expect(settled).toBe(false);

    const materialized = vi.fn();
    internal.pendingUserMessages.push(pendingMessage('must not run', materialized));
    initialNotify();
    const boundaryNotify = await waitForNotify(internal, initialNotify);

    expect(settled).toBe(false);
    expect(materialized).not.toHaveBeenCalled();
    expect(internal.pendingUserMessages).toHaveLength(1);

    internal.retireBoundaryReached = true;
    boundaryNotify();

    await expect(next).resolves.toEqual({ value: undefined, done: true });
    expect(materialized).not.toHaveBeenCalled();
  });

  it('emits the active result before closing and never feeds a queued second turn', async () => {
    const internal = makeInternalSession({
      cwd: '/tmp/claude-retirement-result',
      applicationSid: 'source-sid',
    });
    const query = new MockSdkQuery();
    internal.query = query as unknown as Query;
    internal.retireRequested = true;

    const materialized = vi.fn();
    internal.pendingUserMessages.push(pendingMessage('second turn', materialized));

    const sessions = new Map([['source-sid', internal]]);
    const observations: Array<{
      event: AgentEvent;
      expectedClose: boolean | undefined;
      boundaryReached: boolean | undefined;
    }> = [];
    const processor = new StreamProcessor({
      sessions,
      emit: (event) => {
        observations.push({
          event,
          expectedClose: internal.expectedClose,
          boundaryReached: internal.retireBoundaryReached,
        });
      },
    });

    const inputStream = processor.createUserMessageStream(internal, 'source-sid')[
      Symbol.asyncIterator
    ]();
    const pendingInput = inputStream.next();
    await waitForNotify(internal);

    const consume = processor.consume(internal, 'source-sid', () => undefined);
    query.pushFrame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'handoff complete',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    await expect(consume).resolves.toBeNull();
    await expect(pendingInput).resolves.toEqual({ value: undefined, done: true });

    const finishedIndex = observations.findIndex(({ event }) => event.kind === 'finished');
    const sessionEndIndex = observations.findIndex(({ event }) => event.kind === 'session-end');
    expect(finishedIndex).toBeGreaterThanOrEqual(0);
    expect(sessionEndIndex).toBeGreaterThan(finishedIndex);
    const finished = observations[finishedIndex];
    expect(finished.event).toMatchObject({
      sessionId: 'source-sid',
      kind: 'finished',
      payload: { ok: true, subtype: 'success' },
    });
    expect(finished.expectedClose).not.toBe(true);
    expect(finished.boundaryReached).not.toBe(true);

    expect(internal.retireBoundaryReached).toBe(true);
    expect(internal.expectedClose).toBe(true);
    expect(internal.pendingUserMessages).toHaveLength(0);
    expect(materialized).not.toHaveBeenCalled();
    expect(query.interruptCallCount).toBe(1);
    expect(sessions.has('source-sid')).toBe(false);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('source-sid');
  });
});
