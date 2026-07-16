import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './client';
import log from '@main/utils/logger';
import {
  firstModelEventTimeoutMessage,
  isCodexModelActivity,
} from './first-model-event-watchdog';
import type {
  CodexAppServerNotification,
  CodexAppServerStreamEvent,
} from './protocol';

const THREAD_OPTIONS = {
  workingDirectory: '/repo',
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'never' as const,
  skipGitRepoCheck: true,
};
const logger = log.scope('codex-app-server') as unknown as {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  logger.debug.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Codex first-model-event watchdog', () => {
  it('classifies model-derived activity without accepting lifecycle or echoed user input', () => {
    for (const notification of [
      notify('item/reasoning/summaryTextDelta'),
      notify('item/agentMessage/delta'),
      notify('item/started', { item: { type: 'commandExecution' } }),
      notify('rawResponseItem/completed'),
      notify('turn/diff/updated'),
      notify('turn/plan/updated'),
      notify('thread/tokenUsage/updated'),
    ]) {
      expect(isCodexModelActivity(notification)).toBe(true);
    }

    for (const notification of [
      notify('turn/started'),
      notify('thread/status/changed'),
      notify('warning'),
      notify('error', { willRetry: true }),
      notify('item/started'),
      notify('item/metadata', { item: { type: 'reasoning' } }),
      notify('item/started', { item: { type: 'userMessage' } }),
      notify('item/completed', { item: { type: 'user_message' } }),
    ]) {
      expect(isCodexModelActivity(notification)).toBe(false);
    }
  });

  it('recycles an accepted silent turn once and never replays its input', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50);
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(0);
    expect(client.turnStartCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(50);

    const events = await result;
    expect(client.turnStartCalls).toBe(1);
    expect(client.recycles).toEqual([{
      expectedGeneration: 0,
      threadId: 'thread-1',
      turnId: 'turn-1',
      message: firstModelEventTimeoutMessage(50),
    }]);
    expect(events.map(eventName)).toEqual([
      'thread.started',
      'server.notification:turn/started',
      'server.notification:error',
    ]);
    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('watchdog armed'),
      expect.objectContaining({ phase: 'armed', acceptanceSource: 'notification' }),
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('recycle initiated'),
      expect.objectContaining({ phase: 'timeout', responsePending: false }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls]))
      .not.toContain('do work');
  });

  it('arms from turn/started when the turn/start response never resolves', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, undefined, null);
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(0);
    expect(client.turnStartCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(50);

    const events = await result;
    expect(client.recycles).toHaveLength(1);
    expect(client.pendingTurnStartRejected).toBe(true);
    expect(client.turnStartCalls).toBe(1);
    expect(events.map(eventName)).toEqual([
      'thread.started',
      'server.notification:turn/started',
      'server.notification:error',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ responsePending: true, notificationCount: 1 }),
    );
  });

  it('does not reset the turn/started deadline when the RPC response arrives later', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, undefined, 40);
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(49);
    expect(client.recycles).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await result;
    expect(client.recycles).toHaveLength(1);
  });

  it('uses the RPC response as the fallback acceptance boundary without turn/started', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, undefined, 0, false);
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(50);
    const events = await result;

    expect(client.recycles).toHaveLength(1);
    expect(events.map(eventName)).toEqual([
      'thread.started',
      'server.notification:error',
    ]);
  });

  it('does not cross-claim a missing-thread turn/started across concurrent listeners', async () => {
    vi.useFakeTimers();
    const client = new ConcurrentScriptedClient(50);
    const first = collectTurn(client);
    const second = collectTurn(client);

    await vi.advanceTimersByTimeAsync(39);
    expect(client.turnStartCalls).toBe(2);
    expect(logger.debug).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug.mock.calls.map((call) => call[1]?.acceptanceSource))
      .toEqual(['response', 'response']);

    client.emit(completedTurn('thread-1', 'turn-1'));
    client.emit(completedTurn('thread-2', 'turn-2'));
    const results = await Promise.all([first, second]);

    expect(results.every((events) => eventName(events.at(-1)!) ===
      'server.notification:turn/completed')).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('consumes a response-first same-stack model event before arming the watchdog', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, undefined, 0, false, (current) => {
      for (let index = 0; index < 12; index += 1) {
        current.emit(notify('item/agentMessage/delta', {
          threadId: 'thread-1',
          turnId: `stale-turn-${index}`,
          delta: 'stale model output',
        }));
      }
      current.emit(notify('item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        delta: 'model output',
      }));
      setTimeout(() => current.emit(completedTurn()), 100);
    });
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(60);
    expect(client.recycles).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    const events = await result;

    expect(client.recycles).toEqual([]);
    expect(events.map(eventName)).toContain('server.notification:item/agentMessage/delta');
    expect(events.map(eventName).at(-1)).toBe('server.notification:turn/completed');
    expect(logger.debug.mock.calls.map((call) => call[1]?.phase))
      .toEqual(['first_model_event']);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ notificationCount: 1 }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('consumes a response-first same-stack terminal without arming the watchdog', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, undefined, 0, false, (current) => {
      current.emit(completedTurn());
    });
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(100);
    const events = await result;

    expect(client.recycles).toEqual([]);
    expect(events.map(eventName).at(-1)).toBe('server.notification:turn/completed');
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('disarms on the first model event and waits for the normal terminal event', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, (current) => {
      setTimeout(() => current.emit(notify('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'reasoning-1', type: 'reasoning' },
      })), 10);
      setTimeout(() => current.emit(completedTurn()), 100);
    });
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(60);
    expect(client.recycles).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);

    const events = await result;
    expect(client.recycles).toEqual([]);
    expect(events.map(eventName)).toContain('server.notification:item/started');
    expect(events.map(eventName).at(-1)).toBe('server.notification:turn/completed');
    expect(logger.debug.mock.calls.map((call) => call[1]?.phase))
      .toEqual(['armed', 'first_model_event']);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not let unscoped activity from another pooled thread disarm the watchdog', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, (current) => {
      setTimeout(() => current.emit(notify('item/agentMessage/delta', {
        delta: 'activity with no threadId or turnId',
      })), 10);
    });
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(50);
    const events = await result;

    expect(client.recycles).toHaveLength(1);
    expect(events.map(eventName)).toContain('server.notification:item/agentMessage/delta');
    expect(events.map(eventName).at(-1)).toBe('server.notification:error');
  });

  it.each([
    ['completed turn', () => completedTurn()],
    ['fatal stream error', () => notify('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'provider failed before output' },
    })],
  ])('keeps a %s before model activity as the authoritative terminal', async (_label, terminal) => {
    vi.useFakeTimers();
    const client = new ScriptedClient(50, (current) => {
      setTimeout(() => current.emit(terminal()), 10);
    });
    const result = collectTurn(client);

    await vi.advanceTimersByTimeAsync(100);
    const events = await result;

    expect(client.recycles).toEqual([]);
    expect(events.map(eventName).at(-1)).toBe(`server.notification:${terminal().method}`);
  });
});

class ScriptedClient extends CodexAppServerClient {
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  readonly recycles: Array<{
    expectedGeneration: number;
    threadId: string;
    turnId: string;
    message: string;
  }> = [];
  turnStartCalls = 0;
  pendingTurnStartRejected = false;
  private rejectPendingTurnStart: ((err: Error) => void) | null = null;

  constructor(
    timeoutMs: number,
    private readonly afterTurnStart?: (client: ScriptedClient) => void,
    private readonly responseDelayMs: number | null = 0,
    private readonly emitTurnStarted = true,
    private readonly afterResponseResolved?: (client: ScriptedClient) => void,
  ) {
    super({ env: {}, config: null, firstModelEventTimeoutMs: timeoutMs });
  }

  override request<T = unknown>(method: string, _params: unknown): Promise<T> {
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'thread-1' } } as T);
    }
    if (method === 'turn/start') {
      this.turnStartCalls += 1;
      if (this.emitTurnStarted) {
        this.emit(notify('turn/started', {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'inProgress', items: [] },
        }));
      }
      this.afterTurnStart?.(this);
      if (this.responseDelayMs === null) {
        return new Promise<T>((_resolve, reject) => {
          this.rejectPendingTurnStart = reject;
        });
      }
      if (this.responseDelayMs > 0) {
        return new Promise<T>((resolve) => {
          setTimeout(() => resolve({ turn: { id: 'turn-1' } } as T), this.responseDelayMs!);
        });
      }
      if (this.afterResponseResolved) {
        return new Promise<T>((resolve) => {
          resolve({ turn: { id: 'turn-1' } } as T);
          this.afterResponseResolved?.(this);
        });
      }
      return Promise.resolve({ turn: { id: 'turn-1' } } as T);
    }
    return Promise.resolve({} as T);
  }

  override subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override abortTurnAndRecycleGeneration(
    expectedGeneration: number,
    threadId: string,
    turnId: string,
    err: Error,
  ): boolean {
    this.recycles.push({ expectedGeneration, threadId, turnId, message: err.message });
    if (this.rejectPendingTurnStart) {
      const reject = this.rejectPendingTurnStart;
      this.rejectPendingTurnStart = null;
      this.pendingTurnStartRejected = true;
      reject(err);
    }
    this.emit(notify('error', {
      threadId,
      turnId,
      willRetry: false,
      error: { message: err.message },
    }));
    return true;
  }

  emit(notification: CodexAppServerNotification): void {
    for (const listener of [...this.listeners]) listener(notification);
  }
}

class ConcurrentScriptedClient extends CodexAppServerClient {
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  private nextThread = 1;
  turnStartCalls = 0;

  constructor(timeoutMs: number) {
    super({ env: {}, config: null, firstModelEventTimeoutMs: timeoutMs });
  }

  override request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (method === 'thread/start') {
      const threadId = `thread-${this.nextThread++}`;
      return Promise.resolve({ thread: { id: threadId } } as T);
    }
    if (method === 'turn/start') {
      this.turnStartCalls += 1;
      const threadId = (params as { threadId: string }).threadId;
      const turnId = threadId.replace('thread-', 'turn-');
      if (this.turnStartCalls === 2) {
        setTimeout(() => this.emit(notify('turn/started', {
          turn: { id: 'orphan-turn', status: 'inProgress', items: [] },
        })), 0);
      }
      return new Promise<T>((resolve) => {
        setTimeout(() => resolve({ turn: { id: turnId } } as T), 40);
      });
    }
    return Promise.resolve({} as T);
  }

  override subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(notification: CodexAppServerNotification): void {
    for (const listener of [...this.listeners]) listener(notification);
  }
}

async function collectTurn(client: CodexAppServerClient): Promise<CodexAppServerStreamEvent[]> {
  const thread = client.startThread(THREAD_OPTIONS);
  const { events } = await thread.runStreamed([
    { type: 'text', text: 'do work', text_elements: [] },
  ]);
  const collected: CodexAppServerStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function completedTurn(
  threadId = 'thread-1',
  turnId = 'turn-1',
): CodexAppServerNotification {
  return notify('turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed', items: [] },
  });
}

function notify(method: string, params?: unknown): CodexAppServerNotification {
  return { method, ...(params === undefined ? {} : { params }) };
}

function eventName(event: CodexAppServerStreamEvent): string {
  return event.type === 'thread.started'
    ? event.type
    : `${event.type}:${event.notification.method}`;
}
