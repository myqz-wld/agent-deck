import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcInvoke } from '@shared/ipc-channels';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  enqueued: [] as Array<Record<string, unknown>>,
}));

vi.mock('../_helpers', () => ({
  IpcInputError: class IpcInputError extends Error {},
  on: (channel: string, handler: (...args: unknown[]) => unknown) => {
    state.handlers.set(channel, handler);
  },
}));

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    get: () => ({ id: 'team', archivedAt: null }),
    listActiveMembers: () => [
      { sessionId: 'sender', role: 'lead' },
      { sessionId: 'successor', role: 'teammate' },
    ],
  },
}));
vi.mock('@main/store/agent-deck-message-repo', () => ({ agentDeckMessageRepo: {} }));
vi.mock('@main/store/task-repo', () => ({ taskRepo: {} }));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sessionId: string) => ({
      id: sessionId,
      lifecycle: sessionId === 'old-source' ? 'closed' : 'active',
      archivedAt: null,
    }),
  },
}));
vi.mock('@main/session/manager', () => ({ sessionManager: {} }));
vi.mock('@main/store/event-repo', () => ({ eventRepo: {} }));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/session/summarizer', () => ({ summarizer: { getLastErrors: vi.fn() } }));
vi.mock('@main/teams/universal-message-watcher', () => ({
  enqueueAgentDeckMessage: (input: Record<string, unknown>) => {
    state.enqueued.push(input);
    return {
      ok: true,
      message: {
        id: 'message',
        ...input,
        status: 'pending',
        statusReason: null,
        sentAt: 1,
        deliveredAt: null,
        attemptCount: 0,
        lastAttemptAt: null,
        deliveringSince: null,
        replyToMessageId: null,
      },
    };
  },
}));

import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { registerTeamsIpc } from '../teams';

beforeEach(() => {
  state.handlers.clear();
  state.enqueued.length = 0;
});

describe('AgentDeckTeamSendMessage handoff routing', () => {
  it('validates membership and queues against the successor when UI still sends the old id', async () => {
    const lease = handOffCutoverCoordinator.tryAcquire('old-source')!;
    expect(lease.commit('successor')).toBe(true);
    lease.release();
    registerTeamsIpc();
    const handler = state.handlers.get(IpcInvoke.AgentDeckTeamSendMessage)!;

    const result = await handler({}, {
      teamId: 'team',
      fromSessionId: 'sender',
      toSessionId: 'old-source',
      body: 'arrived after handoff',
    });

    expect(result).toMatchObject({ toSessionId: 'successor' });
    expect(state.enqueued).toEqual([{
      teamId: 'team',
      fromSessionId: 'sender',
      toSessionId: 'successor',
      body: 'arrived after handoff',
    }]);
  });
});
