import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './client';
import type { CodexAppServerNotification } from './protocol';
import log from '@main/utils/logger';

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

describe('Codex app-server generation recycle', () => {
  it('bounds initialize, fences a late response, and recovers lazily on the next generation', async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({ env: {}, config: null });
    const first = installFakeChild(client);
    const request = client.readThread('thread-1');
    const rejection = expect(request).rejects.toThrow(/timed out.*clean process|timed out.*retired/i);

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    const internal = client as unknown as ClientInternals;
    expect(client.generation).toBe(1);
    expect(client.isProcessAlive).toBe(false);
    expect(internal.pending.size).toBe(0);
    expect(internal.generationController.hasCachedReadiness).toBe(false);
    internal.handleLine(first.child, JSON.stringify({
      id: 1,
      result: {},
    }));
    expect(internal.pending.size).toBe(0);

    installFakeChild(client, (message, respond) => {
      if (message.method === 'initialize') respond(message.id, {});
      if (message.method === 'thread/read') {
        respond(message.id, { thread: { id: 'thread-1', turns: [] } });
      }
    });
    await expect(client.readThread('thread-1')).resolves.toMatchObject({
      thread: { id: 'thread-1' },
    });
    expect(client.generation).toBe(1);
    expect(internal.pending.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('applies caller abort while initialize is pending and rejects every pending request', async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({ env: {}, config: null });
    installFakeChild(client);
    const controller = new AbortController();
    const first = client.readThread('one');
    const second = client.request('thread/read', {
      threadId: 'two',
      includeTurns: true,
    }, controller.signal);
    const firstRejection = expect(first).rejects.toThrow(/cancelled|generation changed/i);
    const secondRejection = expect(second).rejects.toThrow(/cancelled.*clean process/i);

    controller.abort();
    await Promise.all([firstRejection, secondRejection]);

    const internal = client as unknown as ClientInternals;
    expect(client.generation).toBe(1);
    expect(internal.pending.size).toBe(0);
    expect(internal.generationController.hasCachedReadiness).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it.each([
    ['thread/start', (client: CodexAppServerClient) => client.startThreadEager(threadOptions())],
    ['thread/resume', (client: CodexAppServerClient) =>
      client.resumeThread('thread-1', threadOptions()).ensureReady()],
    ['thread/fork', (client: CodexAppServerClient) =>
      client.forkThread('thread-1', 'turn-1', threadOptions())],
  ])('bounds a never-settling %s boundary and clears in-flight state', async (_method, invoke) => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({ env: {}, config: null });
    installFakeChild(client, (message, respond) => {
      if (message.method === 'initialize') respond(message.id, {});
    });
    const request = invoke(client);
    const rejection = expect(request).rejects.toThrow(/timed out.*retired/i);

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    const internal = client as unknown as ClientInternals;
    expect(client.generation).toBe(1);
    expect(internal.pending.size).toBe(0);
    expect(internal.generationController.hasCachedReadiness).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('bounds config/read inside preparation and invalidates the per-cwd promise', async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({
      env: {},
      config: null,
    });
    installFakeChild(client, (message, respond) => {
      if (message.method === 'initialize') respond(message.id, {});
    });
    const request = client.startThread(threadOptions()).ensureReady();
    const rejection = expect(request).rejects.toThrow(/timed out.*retired/i);

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    installFakeChild(client, (message, respond) => {
      if (message.method === 'initialize') respond(message.id, {});
      if (message.method === 'config/read') respond(message.id, { config: {} });
      if (message.method === 'thread/start') {
        respond(message.id, { thread: { id: 'recovered-thread' } });
      }
    });
    await expect(client.startThread(threadOptions()).ensureReady())
      .resolves.toBe('recovered-thread');
    expect((client as unknown as ClientInternals).pending.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('uses bounded child retirement on dispose and removes pending work and listeners', async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({ env: {}, config: null });
    const { kill } = installFakeChild(client);
    const notifications: CodexAppServerNotification[] = [];
    client.subscribe((notification) => notifications.push(notification));
    const request = client.readThread('thread-1');
    const rejection = expect(request).rejects.toThrow(/disposed/);

    client.dispose();
    await rejection;

    const internal = client as unknown as ClientInternals & {
      notificationListeners: Set<unknown>;
    };
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(internal.pending.size).toBe(0);
    expect(internal.generationController.hasCachedReadiness).toBe(false);
    expect(internal.notificationListeners.size).toBe(0);
    expect(notifications).toEqual([
      expect.objectContaining({ method: 'error' }),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('delivers one terminal to an accepted turn before fencing its disposed generation', async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({ env: {}, config: null });
    installFakeChild(client, (message, respond) => {
      if (message.method === 'initialize') respond(message.id, {});
      if (message.method === 'thread/start') {
        respond(message.id, { thread: { id: 'thread-1' } });
      }
      if (message.method === 'turn/start') {
        respond(message.id, { turn: { id: 'turn-1' } });
      }
    });
    const thread = client.startThread(threadOptions());
    const collected = (async () => {
      const { events } = await thread.runStreamed([
        { type: 'text', text: 'wait', text_elements: [] },
      ]);
      const methods: string[] = [];
      for await (const event of events) {
        methods.push(event.type === 'server.notification'
          ? `server.notification:${event.notification.method}`
          : event.type);
      }
      return methods;
    })();
    await vi.advanceTimersByTimeAsync(0);

    client.dispose();

    await expect(collected).resolves.toEqual([
      'thread.started',
      'turn.accepted',
      'server.notification:error',
    ]);
    expect((client as unknown as ClientInternals & {
      notificationListeners: Set<unknown>;
    }).notificationListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('rejects pending RPCs, interrupts and reaps the child, and fences late stdout', async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({ env: {}, config: null });
    const writes: string[] = [];
    const kill = vi.fn(() => true);
    const child = {
      stdin: {
        write: vi.fn((value: string) => {
          writes.push(value);
          return true;
        }),
      },
      kill,
      once: vi.fn(),
      exitCode: null,
      signalCode: null,
    } as never;
    const pendingReject = vi.fn();
    const notifications: CodexAppServerNotification[] = [];
    const stderrTail = 'ERROR codex_core provider trace SECRET_DIAGNOSTIC_TEXT';
    const stderrTailBytes = Buffer.byteLength(stderrTail, 'utf8');
    client.subscribe((notification) => notifications.push(notification));

    const internal = client as unknown as {
      child: unknown;
      currentStderrTail: string;
      pending: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
      handleLine: (sourceChild: unknown, raw: string) => void;
    };
    internal.child = child;
    internal.currentStderrTail = stderrTail;
    internal.pending.set(41, { resolve: vi.fn(), reject: pendingReject });
    const error = new Error('accepted turn produced no model activity');

    expect(client.abortTurnAndRecycleGeneration(0, 'thread-1', 'turn-1', error)).toBe(true);

    expect(client.generation).toBe(1);
    expect(client.isProcessAlive).toBe(false);
    expect(pendingReject).toHaveBeenCalledOnce();
    expect(pendingReject).toHaveBeenCalledWith(error);
    expect(internal.pending.size).toBe(0);
    expect(JSON.parse(writes[0].trim())).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(notifications).toEqual([expect.objectContaining({
      method: 'error',
      params: expect.objectContaining({
        willRetry: false,
        error: expect.objectContaining({ message: error.message }),
      }),
    })]);
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('recycle completed'),
      expect.objectContaining({
        event: 'codex_turn_watchdog_recycle',
        outcome: 'completed',
        expectedGeneration: 0,
        actualGeneration: 1,
        pendingRpcCountBefore: 1,
        pendingRpcCountAfter: 0,
        interruptWrite: 'sent',
        sigtermSent: true,
        sigkillScheduled: true,
        hasStderrTail: true,
        stderrTailBytes,
      }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('SECRET_DIAGNOSTIC_TEXT');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    internal.handleLine(child, JSON.stringify({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage' } },
    }));
    expect(notifications).toHaveLength(1);
    expect(client.abortTurnAndRecycleGeneration(0, 'thread-1', 'turn-1', error)).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('recycle fenced'),
      expect.objectContaining({ outcome: 'generation_mismatch' }),
    );
    expect(logger.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('logs malformed stdout metadata without the raw provider line', () => {
    const client = new CodexAppServerClient({ env: {}, config: null });
    const child = { pid: 777 };
    const internal = client as unknown as {
      child: unknown;
      handleLine: (sourceChild: unknown, raw: string) => void;
    };
    internal.child = child;
    const raw = 'not-json prompt=TOP_SECRET raw_tool_args={danger:true}';

    internal.handleLine(child, raw);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse stdout line'),
      expect.objectContaining({
        event: 'codex_app_server_stdout_parse_failed',
        processGeneration: 0,
        processPid: 777,
        bytes: Buffer.byteLength(raw, 'utf8'),
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('TOP_SECRET');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('raw_tool_args');
  });
});

interface ClientInternals {
  child: unknown;
  pending: Map<number | string, unknown>;
  generationController: { hasCachedReadiness: boolean };
  handleLine: (sourceChild: unknown, raw: string) => void;
}

function installFakeChild(
  client: CodexAppServerClient,
  onRequest?: (
    message: { id: number; method: string; params: unknown },
    respond: (id: number, result: unknown) => void,
  ) => void,
): { child: unknown; kill: ReturnType<typeof vi.fn> } {
  const internal = client as unknown as ClientInternals;
  const kill = vi.fn(() => true);
  const child = {
    stdin: {
      write: vi.fn((value: string, callback?: (error?: Error | null) => void) => {
        const message = JSON.parse(value.trim()) as {
          id: number;
          method: string;
          params: unknown;
        };
        callback?.(null);
        onRequest?.(message, (id, result) => {
          queueMicrotask(() => internal.handleLine(child, JSON.stringify({ id, result })));
        });
        return true;
      }),
    },
    kill,
    once: vi.fn(),
    exitCode: null,
    signalCode: null,
  };
  internal.child = child;
  return { child, kill };
}

function threadOptions() {
  return {
    workingDirectory: '/repo',
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'never' as const,
    skipGitRepoCheck: true,
  };
}
