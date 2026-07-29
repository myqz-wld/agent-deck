import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: () => 'mcp-startup-test-run',
}));

import {
  AgentDeckMcpStartupObserver,
  type McpStartupLogEvent,
} from './mcp-startup-observer';
import type { CodexAppServerNotification } from './protocol';

const SLOW_THRESHOLD_MS = 10_000;
const SUMMARY_INTERVAL_MS = 5 * 60_000;

function startup(
  status: 'starting' | 'ready' | 'failed' | 'cancelled',
  threadId = 'thread-secret',
  extra: Record<string, unknown> = {},
): CodexAppServerNotification {
  return {
    method: 'mcpServer/startupStatus/updated',
    params: {
      threadId,
      name: 'agent-deck',
      status,
      ...extra,
    },
  };
}

function details(event: McpStartupLogEvent | null): Record<string, unknown> {
  if (!event) throw new Error('expected startup diagnostic');
  return JSON.parse(event.message) as Record<string, unknown>;
}

describe('AgentDeckMcpStartupObserver', () => {
  it('filters non-Agent-Deck and malformed notifications before reading the clock', () => {
    const now = vi.fn(() => 1_000);
    const observer = new AgentDeckMcpStartupObserver(now);

    expect(observer.observe({ method: 'thread/started', params: {} })).toBeNull();
    expect(observer.observe({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'other-server', status: 'failed' },
    })).toBeNull();
    expect(observer.observe({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'agent-deck', status: 'unknown' },
    })).toBeNull();
    expect(now).not.toHaveBeenCalled();
  });

  it('keeps starting and ready below the slow threshold silent', () => {
    let now = 1_000;
    const observer = new AgentDeckMcpStartupObserver(() => now);

    expect(observer.observe(startup('starting'))).toBeNull();
    now += SLOW_THRESHOLD_MS - 1;
    expect(observer.observe(startup('ready'))).toBeNull();
    expect(observer.observe(startup('ready'))).toBeNull();
  });

  it('warns at the exact slow threshold with a bounded fixed-field message', () => {
    let now = 1_000;
    const observer = new AgentDeckMcpStartupObserver(() => now);
    observer.observe(startup('starting'));

    now += SLOW_THRESHOLD_MS;
    const event = observer.observe(startup('ready'));
    expect(event?.level).toBe('warn');
    expect(details(event)).toEqual({
      event: 'agent-deck-mcp-startup-state',
      runId: 'mcp-startup-test-run',
      state: 'slow',
      previousState: null,
      transition: 'initial',
      durationMs: SLOW_THRESHOLD_MS,
      abnormalDurationMs: 0,
      suppressedCount: 0,
      suppressedCountCapped: false,
      maxDurationMs: SLOW_THRESHOLD_MS,
      slowThresholdMs: SLOW_THRESHOLD_MS,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
    expect(event?.message.length).toBeLessThanOrEqual(512);
  });

  it('distinguishes failures, cancellation, repeats, summary, and recovery', () => {
    let now = 0;
    const observer = new AgentDeckMcpStartupObserver(() => now);
    observer.observe(startup('starting'));

    now = 100;
    const failed = observer.observe(startup('failed'));
    expect(failed?.level).toBe('warn');
    expect(details(failed)).toMatchObject({
      state: 'failed',
      previousState: null,
      transition: 'initial',
      durationMs: 100,
      maxDurationMs: 100,
    });

    now = 150;
    expect(observer.observe(startup('failed'))).toBeNull();
    now = 200;
    const cancelled = observer.observe(startup('cancelled'));
    expect(cancelled?.level).toBe('warn');
    expect(details(cancelled)).toMatchObject({
      state: 'cancelled',
      previousState: 'failed',
      transition: 'transition',
      suppressedCount: 1,
      maxDurationMs: 100,
    });

    now = 300;
    expect(observer.observe(startup('cancelled'))).toBeNull();
    for (let index = 0; index < 10_000; index += 1) {
      observer.observe(startup('cancelled'));
    }
    now = 200 + SUMMARY_INTERVAL_MS;
    const summary = observer.observe(startup('cancelled'));
    expect(summary?.level).toBe('warn');
    expect(details(summary)).toMatchObject({
      state: 'cancelled',
      previousState: 'cancelled',
      transition: 'periodic-summary',
      abnormalDurationMs: 300_100,
      suppressedCount: 9_999,
      suppressedCountCapped: true,
      maxDurationMs: 100,
    });

    now += 100;
    expect(observer.observe(startup('starting'))).toBeNull();
    now += 100;
    const recovered = observer.observe(startup('ready'));
    expect(recovered?.level).toBe('info');
    expect(details(recovered)).toMatchObject({
      state: 'ready',
      previousState: 'cancelled',
      transition: 'transition',
      durationMs: 100,
      suppressedCount: 0,
      maxDurationMs: 100,
    });
    expect(observer.observe(startup('ready'))).toBeNull();
  });

  it('drops raw thread and provider failure content instead of sanitizing it', () => {
    const secret =
      'Bearer private-token /Users/private/repo https://example.test/?token=private';
    const observer = new AgentDeckMcpStartupObserver(() => 1_000);
    const event = observer.observe(startup(
      'failed',
      `thread-${secret}`,
      {
        failureReason: `reason ${secret}`,
        error: new Error(`payload prompt=${secret}`),
      },
    ));

    expect(event?.level).toBe('warn');
    const emitted = event?.message ?? '';
    for (const forbidden of [
      'private-token',
      '/Users/private/repo',
      'example.test',
      'thread-',
      'reason',
      'payload',
      'prompt=',
      '[codex-app-server]',
    ]) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it('bounds thread state to 128 deterministic LRU entries', () => {
    const observer = new AgentDeckMcpStartupObserver(() => 1_000);
    for (let index = 0; index < 128; index += 1) {
      expect(observer.observe(startup('failed', `thread-${index}`))?.level).toBe('warn');
    }

    expect(observer.observe(startup('failed', 'thread-0'))).toBeNull();
    expect(observer.observe(startup('failed', 'thread-128'))?.level).toBe('warn');
    expect(observer.observe(startup('failed', 'thread-0'))).toBeNull();
    const readded = observer.observe(startup('failed', 'thread-1'));
    expect(readded?.level).toBe('warn');
    expect(details(readded)).toMatchObject({
      state: 'failed',
      previousState: null,
      transition: 'initial',
    });
  });

  it('preserves buffered zero-duration uncertainty on recovery', () => {
    let now = 5_000;
    const observer = new AgentDeckMcpStartupObserver(() => now);
    expect(observer.observe(startup('failed'))?.level).toBe('warn');

    expect(observer.observe(startup('starting'))).toBeNull();
    const recovered = observer.observe(startup('ready'));
    expect(recovered?.level).toBe('info');
    expect(details(recovered)).toMatchObject({
      state: 'ready',
      previousState: 'failed',
      durationMs: null,
      maxDurationMs: null,
    });
  });

  it('fails closed on thrown, nonfinite, and rolled-back clocks', () => {
    let clock: number | 'throw' = 100;
    const observer = new AgentDeckMcpStartupObserver(() => {
      if (clock === 'throw') throw new Error('clock failed');
      return clock;
    });
    observer.observe(startup('starting'));

    clock = 'throw';
    let thrownClockResult: McpStartupLogEvent | null = null;
    expect(() => {
      thrownClockResult = observer.observe(startup('failed'));
    }).not.toThrow();
    expect(thrownClockResult).toBeNull();
    clock = Number.NaN;
    expect(observer.observe(startup('failed'))).toBeNull();
    clock = 200;
    expect(details(observer.observe(startup('failed')))).toMatchObject({
      durationMs: 100,
      transition: 'initial',
    });

    clock = 150;
    expect(observer.observe(startup('ready'))).toBeNull();
    clock = 160;
    const afterRollback = observer.observe(startup('failed'));
    expect(details(afterRollback)).toMatchObject({
      state: 'failed',
      previousState: null,
      transition: 'initial',
    });
  });

  it('fails closed on tracker errors and starts fresh on the next event', () => {
    let now = 100;
    const observer = new AgentDeckMcpStartupObserver(() => now);
    observer.observe(startup('starting'));
    const entries = (observer as unknown as {
      entries: Map<string, { tracker: { observe: () => unknown } }>;
    }).entries;
    const entry = entries.values().next().value;
    if (!entry) throw new Error('expected bounded observer entry');
    entry.tracker.observe = () => {
      throw new Error('tracker failed');
    };

    now = 200;
    let failedResult: McpStartupLogEvent | null = null;
    expect(() => {
      failedResult = observer.observe(startup('failed'));
    }).not.toThrow();
    expect(failedResult).toBeNull();
    now = 300;
    const retried = observer.observe(startup('failed'));
    expect(retried?.level).toBe('warn');
    expect(details(retried)).toMatchObject({
      previousState: null,
      transition: 'initial',
    });
  });

  it('reset clears bounded state, timing, and dedupe', () => {
    let now = 100;
    const observer = new AgentDeckMcpStartupObserver(() => now);
    expect(observer.observe(startup('failed'))?.level).toBe('warn');
    expect(observer.observe(startup('failed'))).toBeNull();

    observer.reset();
    now = 50;
    const afterReset = observer.observe(startup('failed'));
    expect(afterReset?.level).toBe('warn');
    expect(details(afterReset)).toMatchObject({
      previousState: null,
      transition: 'initial',
      durationMs: null,
    });
  });
});
