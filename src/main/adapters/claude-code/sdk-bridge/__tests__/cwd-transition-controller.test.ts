import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCwdTransition } from '@main/adapters/types';
import type { InternalSession, PendingUserMessage } from '../types';

const sessionGet = vi.hoisted(() => vi.fn());
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: sessionGet },
}));

import { ClaudeCwdTransitionController } from '../cwd-transition-controller';

function transition(): AgentCwdTransition {
  return {
    sessionId: 'session-a',
    generation: 5,
    direction: 'enter',
    fromCwd: '/repo',
    targetCwd: '/repo/worktree',
    continuationKey: 'cwd:test:5',
    continuationText: 'continue',
  };
}

function internal(cwd: string): InternalSession {
  return {
    applicationSid: 'session-a',
    cliSessionId: 'native-a',
    cwd,
    query: {},
    permissionMode: 'default',
    pendingUserMessages: [],
    userTurnInFlight: false,
    cwdTransitionGeneration: null,
    notify: vi.fn(),
  } as unknown as InternalSession;
}

function pending(text: string): PendingUserMessage {
  return Object.assign(
    vi.fn(async () => ({ type: 'user' })),
    { handOffMessage: { text } },
  ) as unknown as PendingUserMessage;
}

beforeEach(() => {
  sessionGet.mockReset();
  sessionGet.mockReturnValue({
    id: 'session-a',
    agentId: 'claude-code',
    cwd: '/repo',
    runtimeProvider: 'anthropic',
    permissionMode: 'default',
  });
});

describe('ClaudeCwdTransitionController', () => {
  it('recreates the same application session through provider-neutral continuation at target cwd', async () => {
    const source = internal('/repo');
    const queued = pending('queued before enter');
    source.pendingUserMessages.push(queued);
    source.acceptedEnqueueFingerprints = new Map([['queued-key', 'fingerprint']]);
    const sessions = new Map<string, InternalSession>([['session-a', source]]);
    const closeSession = vi.fn(async () => {
      sessions.delete('session-a');
    });
    const createSession = vi.fn(async (options: any) => {
      const replacement = internal(options.cwd);
      replacement.acceptedEnqueueFingerprints = new Map([
        [options.initialEnqueueOptions.idempotencyKey, 'continuation'],
      ]);
      sessions.set('session-a', replacement);
      return { sessionId: 'session-a', abort: vi.fn() };
    });
    const capture = vi.fn((input: any) => ({
      spoolId: `capture:${input.overrides.cwd}`,
    }));
    const prepare = vi.fn(async (input: any) => ({
      turn: { persistedUserText: input.continuationInstruction },
    }));
    const cleanup = vi.fn();
    const controller = new ClaudeCwdTransitionController({
      sessions,
      closeSession,
      createSession,
      capture,
      prepare,
      cleanup,
    } as any);

    controller.arm(transition());
    await expect(controller.switchCwd(transition())).resolves.toEqual({
      continuationAccepted: true,
    });

    expect(closeSession).toHaveBeenCalledWith('session-a', {
      markRecentlyDeleted: false,
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/worktree',
        resume: 'session-a',
        resumeMode: 'fresh-cli-reuse-app',
        trustedContinuation: expect.any(Object),
        initialEnqueueOptions: expect.objectContaining({
          idempotencyKey: 'cwd:test:5',
          userEventAlreadyPersisted: true,
        }),
      }),
    );
    expect(sessions.get('session-a')?.cwd).toBe('/repo/worktree');
    expect(sessions.get('session-a')?.cwdTransitionGeneration).toBe(5);
    expect(sessions.get('session-a')?.pendingUserMessages).toEqual([queued]);
    expect(sessions.get('session-a')?.acceptedEnqueueFingerprints).toEqual(
      new Map([
        ['queued-key', 'fingerprint'],
        ['cwd:test:5', 'continuation'],
      ]),
    );
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('recreates the source cwd and fails closed when target creation fails', async () => {
    const source = internal('/repo');
    const queued = pending('queued before rollback');
    source.pendingUserMessages.push(queued);
    source.acceptedEnqueueFingerprints = new Map([['rollback-key', 'fingerprint']]);
    const sessions = new Map<string, InternalSession>([['session-a', source]]);
    const createSession = vi.fn(async (options: any) => {
      if (options.cwd === '/repo/worktree') {
        throw new Error('target unavailable');
      }
      sessions.set('session-a', internal(options.cwd));
      return { sessionId: 'session-a', abort: vi.fn() };
    });
    const controller = new ClaudeCwdTransitionController({
      sessions,
      closeSession: async () => {
        sessions.delete('session-a');
      },
      createSession,
      capture: (input: any) => ({
        spoolId: `capture:${input.overrides.cwd}`,
      }),
      prepare: async (input: any) => ({
        turn: { persistedUserText: input.continuationInstruction },
      }),
      cleanup: vi.fn(),
    } as any);

    controller.arm(transition());
    await expect(controller.switchCwd(transition())).rejects.toThrow(
      '已恢复 /repo',
    );
    expect(createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(sessions.get('session-a')?.cwd).toBe('/repo');
    expect(sessions.get('session-a')?.cwdTransitionGeneration).toBe(5);
    expect(sessions.get('session-a')?.pendingUserMessages).toEqual([queued]);
    expect(sessions.get('session-a')?.acceptedEnqueueFingerprints).toEqual(
      new Map([['rollback-key', 'fingerprint']]),
    );
  });
});
