import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';
import { CodexSessionCommandController } from './session-command-controller';

function session(thread: Record<string, unknown>): InternalSession {
  return {
    applicationSid: 'app-session',
    threadId: 'native-old',
    thread,
    pendingMessages: [],
    pendingPermissions: new Map(),
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
  } as unknown as InternalSession;
}

function harness(internal: InternalSession) {
  const events: AgentEvent[] = [];
  const updateCliSessionId = vi.fn();
  const runTurnLoop = vi.fn(async () => undefined);
  const sessions = new Map([[internal.applicationSid, internal]]);
  const controller = new CodexSessionCommandController({
    sessions,
    emit: (event) => events.push(event),
    runTurnLoop,
    runtimeHost: {
      sessions: { updateCliSessionId },
      records: { get: () => ({ model: 'gpt-5.6-sol' }) },
      liveRate: { emitTokenRateTick: vi.fn() },
      observeIgnoredAppServerItemType: vi.fn(),
      observeHeuristicStreamError: vi.fn(),
    } as never,
  });
  return { controller, events, runTurnLoop, updateCliSessionId };
}

describe('Codex session command controller', () => {
  it('binds /clear to a fresh native thread while preserving the application id', async () => {
    const fresh = {
      ensureReady: vi.fn(async () => 'native-new'),
      getRuntimeIdentity: vi.fn(() => null),
    };
    const internal = session({ createFreshThread: () => fresh });
    const { controller, events, updateCliSessionId } = harness(internal);

    await controller.execute('app-session', 'clear');

    expect(internal.applicationSid).toBe('app-session');
    expect(internal.threadId).toBe('native-new');
    expect(internal.thread).toBe(fresh);
    expect(updateCliSessionId).toHaveBeenCalledWith('app-session', 'native-new');
    expect(events.map((event) => event.kind)).toEqual([
      'context-usage',
      'message',
      'finished',
    ]);
    expect(events[1]?.payload).toMatchObject({
      role: 'system',
      text: 'Codex /clear 已完成，已开始新对话，原时间线保留',
      sessionCommandStatus: { command: 'clear', status: 'completed' },
    });
    expect(events[2]?.payload).toEqual({ ok: true, subtype: 'end_turn' });
  });

  it('closes /clear activity as failed when the native thread cannot start', async () => {
    const internal = session({
      createFreshThread: () => ({
        ensureReady: vi.fn(async () => {
          throw new Error('native start failed');
        }),
      }),
    });
    const { controller, events } = harness(internal);

    await expect(controller.execute('app-session', 'clear')).rejects.toThrow(
      'native start failed',
    );

    expect(events.map((event) => event.kind)).toEqual(['message', 'finished']);
    expect(events[0]?.payload).toMatchObject({
      role: 'system',
      text: 'Codex /clear 失败：native start failed',
      error: true,
      sessionCommandStatus: { command: 'clear', status: 'failed' },
    });
    expect(events[1]?.payload).toEqual({ ok: false, subtype: 'error' });
    expect(internal.activeControlCommand).toBeNull();
    expect(internal.turnLoopRunning).toBe(false);
  });

  it('runs /compact as a non-steerable background control turn then drains queued input', async () => {
    const compactStreamed = vi.fn(async () => ({
      events: (async function* () {
        yield {
          type: 'server.notification' as const,
          notification: {
            method: 'item/started',
            params: { threadId: 'native-old', turnId: 'turn-a', item: {
              id: 'compact-a', type: 'contextCompaction',
            } },
          },
          runtimeIdentity: null,
        };
        yield {
          type: 'server.notification' as const,
          notification: {
            method: 'turn/completed',
            params: { threadId: 'native-old', turn: { id: 'turn-a', status: 'completed' } },
          },
          runtimeIdentity: null,
        };
      })(),
    }));
    const internal = session({ compactStreamed });
    const { controller, events, runTurnLoop } = harness(internal);

    await controller.execute('app-session', 'compact');
    expect(internal.activeControlCommand).toBe('compact');
    internal.pendingMessages.push('follow-up');
    await vi.waitFor(() => expect(internal.activeControlCommand).toBeNull());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'message',
      payload: {
        role: 'system',
        text: 'Codex /compact 已完成',
        sessionCommandStatus: { command: 'compact', status: 'completed' },
      },
    });
    expect(events[1]).toMatchObject({
      kind: 'finished',
      payload: { ok: true, subtype: 'end_turn' },
    });
    expect(runTurnLoop).toHaveBeenCalledWith(internal, 'app-session');
  });

  it('reports a failed /compact turn as one final system message', async () => {
    const internal = session({
      compactStreamed: vi.fn(async () => ({
        events: (async function* () {
          yield {
            type: 'server.notification' as const,
            notification: {
              method: 'turn/completed',
              params: {
                threadId: 'native-old',
                turn: {
                  id: 'turn-a',
                  status: 'failed',
                  error: { message: 'summary failed' },
                },
              },
            },
            runtimeIdentity: null,
          };
        })(),
      })),
    });
    const { controller, events } = harness(internal);

    await controller.execute('app-session', 'compact');
    await vi.waitFor(() => expect(internal.activeControlCommand).toBeNull());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'message',
      payload: {
        role: 'system',
        text: 'Codex /compact 失败：summary failed',
        error: true,
        sessionCommandStatus: { command: 'compact', status: 'failed' },
      },
    });
    expect(events[1]).toMatchObject({
      kind: 'finished',
      payload: { ok: false, subtype: 'error' },
    });
  });
});
