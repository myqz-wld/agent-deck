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
    expect(events.map((event) => event.kind)).toEqual(['context-usage', 'message']);
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

    expect(events.map((event) => event.kind)).toEqual([
      'context-compaction-start',
      'finished',
    ]);
    expect(runTurnLoop).toHaveBeenCalledWith(internal, 'app-session');
  });
});
