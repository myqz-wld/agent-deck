import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './client';
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

afterEach(() => {
  vi.useRealTimers();
});

describe('Codex accepted-turn cancellation', () => {
  it('does not start a dead client generation merely to send an interrupt', () => {
    const client = new CodexAppServerClient({ env: {}, config: null });

    expect(client.sendTurnInterrupt(0, 'thread-1', 'turn-1')).toBe(false);
    expect(client.isProcessAlive).toBe(false);
    expect(client.generation).toBe(0);
  });

  it('recycles without an interrupt when aborted before any turn id is accepted', async () => {
    const controller = new AbortController();
    const client = new CancellationClient();
    client.turnStart = () => new Promise(() => undefined);
    const { iterator } = await beginTurn(client, controller.signal);
    const acceptance = iterator.next();
    await Promise.resolve();

    controller.abort();

    await expect(acceptance).rejects.toThrow('Codex turn interrupted');
    expect(client.interrupts).toEqual([]);
    expect(client.recycles).toHaveLength(1);
    expect(client.listenerCount).toBe(0);
  });

  it('covers the turn/start acceptance race with one native interrupt', async () => {
    const controller = new AbortController();
    const client = new CancellationClient();
    client.onInterrupt = () => queueMicrotask(() => client.emit(interruptedTurn()));
    client.turnStart = () => new Promise(() => {
      client.emit(startedTurn());
      controller.abort();
    });
    const { iterator } = await beginTurn(client, controller.signal);

    await expect(iterator.next()).rejects.toThrow('Codex turn interrupted');

    expect(client.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(client.recycles).toHaveLength(1);
    expect(client.listenerCount).toBe(0);
  });

  it('interrupts exactly once when aborted immediately after acceptance', async () => {
    const controller = new AbortController();
    const client = new CancellationClient();
    client.onInterrupt = () => queueMicrotask(() => client.emit(interruptedTurn()));
    const { iterator } = await acceptedTurn(client, controller.signal);

    controller.abort();
    expect(client.recycles).toHaveLength(1);

    await expect(iterator.next()).rejects.toThrow('Codex turn interrupted');
    expect(client.interrupts).toHaveLength(1);
    expect(client.listenerCount).toBe(0);
  });

  it('shares exactly one interrupt between streaming abort and the live controller', async () => {
    const controller = new AbortController();
    const client = new CancellationClient();
    client.onInterrupt = () => queueMicrotask(() => client.emit(interruptedTurn()));
    const { iterator, thread } = await acceptedTurn(client, controller.signal);
    client.emit(notification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'partial',
    }));
    expect(eventName((await iterator.next()).value)).toBe(
      'server.notification:item/agentMessage/delta',
    );

    controller.abort();
    const liveInterrupt = thread.interrupt('turn-1');

    await expect(iterator.next()).rejects.toThrow('Codex turn interrupted');
    await liveInterrupt;
    expect(client.interrupts).toHaveLength(1);
    expect(client.recycles).toHaveLength(1);
  });

  it('interrupts and drains when run() rejects on maxOutputBytes overflow', async () => {
    const client = new CancellationClient();
    client.onTurnStarted = () => queueMicrotask(() => client.emit(notification(
      'item/completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', text: 'far too much output' },
      },
    )));
    client.onInterrupt = () => queueMicrotask(() => client.emit(interruptedTurn()));
    const thread = client.startThread(THREAD_OPTIONS);

    await expect(thread.run(input(), { maxOutputBytes: 4 })).rejects.toThrow(
      'output exceeded byte limit',
    );

    expect(client.interrupts).toHaveLength(1);
    expect(client.recycles).toEqual([]);
    expect(client.listenerCount).toBe(0);
  });

  it('recycles immediately when the one interrupt write fails', async () => {
    const controller = new AbortController();
    const client = new CancellationClient();
    client.interruptSucceeds = false;
    const { iterator } = await acceptedTurn(client, controller.signal);

    controller.abort();

    await expect(iterator.next()).rejects.toThrow('Codex turn interrupted');
    expect(client.interrupts).toHaveLength(1);
    expect(client.recycles).toHaveLength(1);
    expect(client.listenerCount).toBe(0);
  });

  it('lets a synchronous terminal win the interrupt-versus-recycle race', async () => {
    const client = new CancellationClient();
    client.onInterrupt = () => client.emit(interruptedTurn());
    const { iterator } = await acceptedTurn(client);

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });

    expect(client.interrupts).toHaveLength(1);
    expect(client.recycles).toEqual([]);
    expect(client.listenerCount).toBe(0);
  });

  it('waits a bounded interval, recycles, and unsubscribes before consumer cleanup returns', async () => {
    vi.useFakeTimers();
    const client = new CancellationClient();
    const { iterator } = await acceptedTurn(client);

    const cleanup = iterator.return?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(client.interrupts).toHaveLength(1);
    expect(client.recycles).toEqual([]);
    expect(client.listenerCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(cleanup).resolves.toMatchObject({ done: true });
    expect(client.recycles).toHaveLength(1);
    expect(client.listenerCount).toBe(0);
  });
});

class CancellationClient extends CodexAppServerClient {
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly recycles: Array<{ message: string; phase: string }> = [];
  interruptSucceeds = true;
  onInterrupt: (() => void) | null = null;
  onTurnStarted: (() => void) | null = null;
  turnStart: (() => Promise<{ turn: { id: string } }>) | null = null;

  constructor() {
    super({ env: {}, config: null, firstModelEventTimeoutMs: 60_000 });
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  override request<T = unknown>(method: string): Promise<T> {
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'thread-1' } } as T);
    }
    if (method === 'turn/start') {
      const request = this.turnStart?.() ?? Promise.resolve({ turn: { id: 'turn-1' } });
      this.onTurnStarted?.();
      return request as Promise<T>;
    }
    return Promise.resolve({} as T);
  }

  override subscribe(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override sendTurnInterrupt(
    _expectedGeneration: number,
    threadId: string,
    turnId: string,
  ): boolean {
    this.interrupts.push({ threadId, turnId });
    if (!this.interruptSucceeds) return false;
    this.onInterrupt?.();
    return true;
  }

  override recycleGeneration(
    _expectedGeneration: number,
    error: Error,
    phase: string,
  ): boolean {
    this.recycles.push({ message: error.message, phase });
    this.emit(notification('error', {
      willRetry: false,
      error: { message: error.message },
    }));
    return true;
  }

  emit(value: CodexAppServerNotification): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

async function beginTurn(client: CancellationClient, signal?: AbortSignal) {
  const thread = client.startThread(THREAD_OPTIONS);
  const { events } = await thread.runStreamed(input(), { signal });
  const iterator = events[Symbol.asyncIterator]();
  expect(eventName((await iterator.next()).value)).toBe('thread.started');
  return { iterator, thread };
}

async function acceptedTurn(client: CancellationClient, signal?: AbortSignal) {
  const started = await beginTurn(client, signal);
  expect(eventName((await started.iterator.next()).value)).toBe('turn.accepted');
  return started;
}

function input() {
  return [{ type: 'text' as const, text: 'do work', text_elements: [] }];
}

function startedTurn(): CodexAppServerNotification {
  return notification('turn/started', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'inProgress', items: [] },
  });
}

function interruptedTurn(): CodexAppServerNotification {
  return notification('turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'interrupted', items: [] },
  });
}

function notification(method: string, params?: unknown): CodexAppServerNotification {
  return { method, ...(params === undefined ? {} : { params }) };
}

function eventName(event: CodexAppServerStreamEvent | undefined): string {
  if (!event) return 'done';
  if (event.type === 'thread.started' || event.type === 'turn.accepted') return event.type;
  return `${event.type}:${event.notification.method}`;
}
