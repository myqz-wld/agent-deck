import { describe, expect, it, vi } from 'vitest';

import type { AgentCwdTransition } from '@main/adapters/types';
import {
  ClaudeCwdTransitionControllerCore,
  type ClaudeCwdTransitionContext,
  type ClaudeCwdTransitionHost,
} from './cwd-transition-controller-core';
import type { InternalSession } from './types';

function transition(overrides: Partial<AgentCwdTransition> = {}): AgentCwdTransition {
  return {
    sessionId: 'session-a',
    generation: 5,
    direction: 'enter',
    fromCwd: '/repo',
    targetCwd: '/repo/worktree',
    continuationKey: 'cwd:test:5',
    continuationText: 'continue',
    ...overrides,
  };
}

function internal(overrides: Partial<InternalSession> = {}): InternalSession {
  return {
    applicationSid: 'session-a',
    cliSessionId: 'native-a',
    cwd: '/repo',
    query: {},
    permissionMode: 'default',
    pendingUserMessages: [],
    userTurnInFlight: false,
    cwdTransitionGeneration: null,
    notify: vi.fn(),
    ...overrides,
  } as unknown as InternalSession;
}

function context(sessions: Map<string, InternalSession>): ClaudeCwdTransitionContext {
  return {
    sessions,
    closeSession: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({ sessionId: 'session-a', abort: vi.fn() })),
    capture: vi.fn(() => ({ spoolId: 'capture' }) as never),
    prepare: vi.fn(async () => ({ turn: {} }) as never),
    cleanup: vi.fn(),
  };
}

function host(
  getSession = vi.fn(() => ({ id: 'session-a' }) as never),
): ClaudeCwdTransitionHost {
  return { getSession };
}

describe('ClaudeCwdTransitionControllerCore', () => {
  it('arms one generation and releases only that generation', () => {
    const session = internal();
    const controller = new ClaudeCwdTransitionControllerCore(
      context(new Map([['session-a', session]])),
      host(),
    );

    controller.arm(transition());
    controller.arm(transition());
    expect(() => controller.arm(transition({ generation: 6 }))).toThrow(
      'already has cwd transition generation 5',
    );
    expect(controller.runtimeCwd('session-a')).toBe('/repo');
    controller.release('session-a', 6);
    expect(session.cwdTransitionGeneration).toBe(5);
    controller.release('session-a', 5);
    expect(session.cwdTransitionGeneration).toBeNull();
    expect(session.notify).toHaveBeenCalledOnce();
  });

  it('rejects an unarmed or active-turn switch before reading persistence', async () => {
    const getSession = vi.fn();
    const session = internal();
    const controller = new ClaudeCwdTransitionControllerCore(
      context(new Map([['session-a', session]])),
      host(getSession),
    );

    await expect(controller.switchCwd(transition())).rejects.toThrow('is not armed');
    controller.arm(transition());
    session.userTurnInFlight = true;
    await expect(controller.switchCwd(transition())).rejects.toThrow(
      'before the active turn ended',
    );
    expect(getSession).not.toHaveBeenCalled();
  });

  it('accepts an already-current target without rebuilding the provider runtime', async () => {
    const getSession = vi.fn();
    const session = internal({ cwd: '/repo/worktree' });
    const bridge = context(new Map([['session-a', session]]));
    const controller = new ClaudeCwdTransitionControllerCore(bridge, host(getSession));

    controller.arm(transition());
    await expect(controller.switchCwd(transition())).resolves.toEqual({
      continuationAccepted: false,
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(bridge.closeSession).not.toHaveBeenCalled();
    expect(bridge.createSession).not.toHaveBeenCalled();
  });

  it('fails before capture when the persisted session is missing', async () => {
    const session = internal();
    const bridge = context(new Map([['session-a', session]]));
    const controller = new ClaudeCwdTransitionControllerCore(
      bridge,
      host(vi.fn(() => null)),
    );

    controller.arm(transition());
    await expect(controller.switchCwd(transition())).rejects.toThrow(
      'session session-a not found',
    );
    expect(bridge.capture).not.toHaveBeenCalled();
  });
});
