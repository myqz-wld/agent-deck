import { describe, expect, it, vi } from 'vitest';
import type { AgentCwdTransition } from '@main/adapters/types';
import type { InternalSession } from '../types';
import { CodexCwdTransitionController } from '../cwd-transition-controller';

function transition(): AgentCwdTransition {
  return {
    sessionId: 'session-a',
    generation: 2,
    direction: 'enter',
    fromCwd: '/repo',
    targetCwd: '/repo/worktree',
    continuationKey: 'cwd:test:2',
    continuationText: 'continue',
  };
}

function session(): InternalSession {
  return {
    applicationSid: 'session-a',
    threadId: 'native-a',
    cwd: '/repo',
    thread: {
      updateWorkingDirectory: vi.fn(),
    },
    pendingMessages: ['ordinary'],
    pendingDeferredUserEvents: [null],
    pendingHandOffMessages: [null],
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    cwdTransitionGeneration: null,
    intentionallyClosed: false,
    pendingPermissions: new Map(),
  } as unknown as InternalSession;
}

describe('CodexCwdTransitionController', () => {
  it('applies cwd to the next app-server turn and releases continuation first', () => {
    const internal = session();
    const sessions = new Map([['session-a', internal]]);
    const runTurnLoop = vi.fn(async () => {});
    const controller = new CodexCwdTransitionController({
      sessions,
      runTurnLoop,
    });
    const input = transition();

    controller.arm(input);
    controller.switchCwd(input);
    controller.enqueueContinuation(input, 'continue');
    controller.enqueueContinuation(input, 'continue');

    expect(internal.thread.updateWorkingDirectory).toHaveBeenCalledWith(
      '/repo/worktree',
    );
    expect(internal.cwd).toBe('/repo/worktree');
    expect(internal.pendingMessages).toEqual(['continue', 'ordinary']);
    expect(internal.pendingDeferredUserEvents).toEqual([null, null]);
    expect(internal.pendingHandOffMessages).toEqual([null, null]);
    expect(runTurnLoop).not.toHaveBeenCalled();

    controller.release('session-a', 2);
    expect(internal.cwdTransitionGeneration).toBeNull();
    expect(runTurnLoop).toHaveBeenCalledWith(internal, 'session-a');
  });

  it('rejects a conflicting generation without mutating the live thread', () => {
    const internal = session();
    internal.cwdTransitionGeneration = 1;
    const controller = new CodexCwdTransitionController({
      sessions: new Map([['session-a', internal]]),
      runTurnLoop: vi.fn(async () => {}),
    });
    expect(() => controller.arm(transition())).toThrow(
      'already has cwd transition generation 1',
    );
    expect(internal.thread.updateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('cancels and requeues a steer that was still awaiting provider acceptance', () => {
    const internal = session();
    const requestController = new AbortController();
    internal.submittingUserMessage = {
      event: { text: 'in-flight correction', turnCorrelationId: 'steer-1' },
      cancelled: false,
      kind: 'steer',
      requestController,
    };
    const controller = new CodexCwdTransitionController({
      sessions: new Map([['session-a', internal]]),
      runTurnLoop: vi.fn(async () => {}),
    });

    controller.arm(transition());

    expect(requestController.signal.aborted).toBe(true);
    expect(internal.submittingUserMessage).toBeNull();
    expect(internal.pendingMessages).toEqual([
      'in-flight correction',
      'ordinary',
    ]);
    expect(internal.pendingDeferredUserEvents).toEqual([
      { text: 'in-flight correction', turnCorrelationId: 'steer-1' },
      null,
    ]);
    expect(internal.pendingHandOffMessages).toEqual([
      { text: 'in-flight correction' },
      null,
    ]);
    expect(internal.cwdTransitionGeneration).toBe(2);
  });
});
