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
