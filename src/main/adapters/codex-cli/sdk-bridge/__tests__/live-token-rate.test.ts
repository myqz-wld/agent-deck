import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAppServerNotification } from '../../app-server/client';
import type { InternalSession } from '../types';

vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: vi.fn(() => ({ model: 'codex-default' })) },
}));

import { eventBus } from '@main/event-bus';
import {
  handleCodexAppServerNotificationForLiveRate,
  observeCodexNotificationUsage,
} from '../live-token-rate';

const emitMock = vi.mocked(eventBus.emit);

function makeInternalSession(over: Partial<InternalSession> = {}): InternalSession {
  return {
    applicationSid: 'sid-1',
    threadId: 'sid-1',
    cwd: '/tmp',
    thread: {} as unknown as InternalSession['thread'],
    pendingMessages: [],
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
    pendingPermissions: new Map(),
    ...over,
    runtimeIdentity: over.runtimeIdentity ?? null,
  };
}

function notify(method: string, params?: unknown): CodexAppServerNotification {
  return { method, params };
}

function usageDelta(outputTokens: number, reasoningOutputTokens = 0): CodexAppServerNotification {
  return notify('thread/tokenUsage/updated', {
    tokenUsage: {
      last: {
        inputTokens: 0,
        outputTokens,
        reasoningOutputTokens,
        cachedInputTokens: 0,
      },
    },
  });
}

function cumulativeUsage(
  totalOutputTokens: number,
  lastOutputTokens: number,
): CodexAppServerNotification {
  return notify('thread/tokenUsage/updated', {
    tokenUsage: {
      total: {
        totalTokens: totalOutputTokens,
        inputTokens: 0,
        outputTokens: totalOutputTokens,
        reasoningOutputTokens: 0,
        cachedInputTokens: 0,
      },
      last: {
        totalTokens: lastOutputTokens,
        inputTokens: 0,
        outputTokens: lastOutputTokens,
        reasoningOutputTokens: 0,
        cachedInputTokens: 0,
      },
    },
  });
}

describe('codex app-server live-token-rate', () => {
  beforeEach(() => {
    emitMock.mockClear();
  });

  it('uses tokenUsage.last as authoritative delta over the previous usage tick interval', () => {
    const internal = makeInternalSession();

    handleCodexAppServerNotificationForLiveRate(notify('turn/started'), internal, 'sid-1', 1000);
    handleCodexAppServerNotificationForLiveRate(usageDelta(30, 15), internal, 'sid-1', 1300);
    handleCodexAppServerNotificationForLiveRate(usageDelta(10, 5), internal, 'sid-1', 1600);

    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(emitMock.mock.calls[0]).toEqual([
      'token-rate-tick',
      {
        sessionId: 'sid-1',
        bucketKey: 'codex-default',
        tps: 30 / 0.3,
        ts: 1300,
      },
    ]);
    expect(emitMock.mock.calls[1]).toEqual([
      'token-rate-tick',
      {
        sessionId: 'sid-1',
        bucketKey: 'codex-default',
        tps: 10 / 0.3,
        ts: 1600,
      },
    ]);
  });

  it('does not emit estimates from app-server text deltas or completed text items', () => {
    const internal = makeInternalSession();

    handleCodexAppServerNotificationForLiveRate(notify('turn/started'), internal, 'sid-1', 1000);
    handleCodexAppServerNotificationForLiveRate(
      notify('item/agentMessage/delta', { delta: 'abcdefgh' }),
      internal,
      'sid-1',
      1300,
    );
    handleCodexAppServerNotificationForLiveRate(
      notify('item/completed', { item: { id: 'm-1', type: 'agentMessage', text: 'abcdefgh' } }),
      internal,
      'sid-1',
      1600,
    );

    expect(emitMock).not.toHaveBeenCalled();
  });

  it('suppresses a repeated positive last snapshot and rates only cumulative output growth', () => {
    const internal = makeInternalSession();

    handleCodexAppServerNotificationForLiveRate(notify('turn/started'), internal, 'sid-1', 1000);
    handleCodexAppServerNotificationForLiveRate(cumulativeUsage(20, 20), internal, 'sid-1', 1500);
    handleCodexAppServerNotificationForLiveRate(cumulativeUsage(20, 20), internal, 'sid-1', 2000);
    handleCodexAppServerNotificationForLiveRate(cumulativeUsage(30, 10), internal, 'sid-1', 2500);

    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(emitMock.mock.calls[0]?.[1]).toMatchObject({ tps: 40, ts: 1500 });
    expect(emitMock.mock.calls[1]?.[1]).toMatchObject({ tps: 20, ts: 2500 });
  });

  it('fingerprints cumulative usage by native thread id after an application-session fallback', () => {
    const internal = makeInternalSession({
      applicationSid: 'stable-app-sid',
      threadId: 'replacement-native-thread',
    });

    const observation = observeCodexNotificationUsage(cumulativeUsage(20, 20), internal);

    expect(observation?.messageId).toBe(
      'codex-usage-v2:replacement-native-thread:20-0-20-0-0-x',
    );
  });

  it('turn/completed emits done tick and clears live state without recomputing usage', () => {
    const internal = makeInternalSession();

    handleCodexAppServerNotificationForLiveRate(notify('turn/started'), internal, 'sid-1', 1000);
    handleCodexAppServerNotificationForLiveRate(usageDelta(10, 5), internal, 'sid-1', 1500);
    handleCodexAppServerNotificationForLiveRate(notify('turn/completed'), internal, 'sid-1', 1700);

    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(emitMock.mock.calls[1]).toEqual([
      'token-rate-tick',
      {
        sessionId: 'sid-1',
        bucketKey: 'codex-default',
        tps: 0,
        ts: 1700,
        done: true,
      },
    ]);
    expect(internal.codexLiveTokenEstimate).toBeUndefined();
  });

  it('transient errors keep usage state; fatal errors clear renderer live state', () => {
    const internal = makeInternalSession();
    handleCodexAppServerNotificationForLiveRate(notify('turn/started'), internal, 'sid-1', 1000);

    handleCodexAppServerNotificationForLiveRate(
      notify('error', { willRetry: true, error: { message: 'Reconnecting...' } }),
      internal,
      'sid-1',
      1200,
    );
    expect(emitMock).not.toHaveBeenCalled();
    expect(internal.codexLiveTokenEstimate).toBeDefined();

    handleCodexAppServerNotificationForLiveRate(
      notify('error', { willRetry: false, error: { message: 'boom' } }),
      internal,
      'sid-1',
      1500,
    );

    expect(emitMock).toHaveBeenCalledWith('token-rate-tick', {
      sessionId: 'sid-1',
      bucketKey: 'codex-default',
      tps: 0,
      ts: 1500,
      done: true,
    });
    expect(internal.codexLiveTokenEstimate).toBeUndefined();
  });
});
