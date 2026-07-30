import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCwdTransition } from '@main/adapters/types';
import type { InternalSession } from '../types';

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
    const sessions = new Map<string, InternalSession>([
      ['session-a', internal('/repo')],
    ]);
    const closeSession = vi.fn(async () => {
      sessions.delete('session-a');
    });
    const createSession = vi.fn(async (options: any) => {
      sessions.set('session-a', internal(options.cwd));
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
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('recreates the source cwd and fails closed when target creation fails', async () => {
    const sessions = new Map<string, InternalSession>([
      ['session-a', internal('/repo')],
    ]);
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
  });
});
