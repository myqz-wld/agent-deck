import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionRecord,
} from '@shared/types';
import type { WorktreeTransitionRecord } from '../types';

const harness = vi.hoisted(() => ({
  listener: null as ((session: SessionRecord) => void) | null,
  session: null as SessionRecord | null,
  transition: null as WorktreeTransitionRecord | null,
  recover: vi.fn(async () => {}),
  off: vi.fn(),
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    on: (_name: string, listener: (session: SessionRecord) => void) => {
      harness.listener = listener;
      return harness.off;
    },
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: () => harness.session,
  },
}));

vi.mock('@main/store/worktree-transition-repo', () => ({
  worktreeTransitionRepo: {
    get: () => harness.transition,
    listRecoverable: () => (harness.transition ? [harness.transition] : []),
  },
}));

vi.mock('../recovery', () => ({
  recoverWorktreeTransition: harness.recover,
}));

import {
  startWorktreeTransitionResumeRecovery,
  stopWorktreeTransitionResumeRecovery,
} from '../resume-recovery';

function session(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id: 'session-a',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'test',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function transition(
  phase: WorktreeTransitionRecord['phase'],
): WorktreeTransitionRecord {
  return {
    sessionId: 'session-a',
    generation: 2,
    direction: 'enter',
    phase,
    originalCwd: '/repo',
    targetCwd: '/repo/worktree',
    mainRepo: '/repo',
    worktreePath: '/repo/worktree',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-a',
    continuationKey: 'cwd:test:2',
    continuationDelivered: false,
    discardChanges: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

beforeEach(() => {
  stopWorktreeTransitionResumeRecovery();
  harness.listener = null;
  harness.session = session();
  harness.transition = transition('enter_waiting_tool_result');
  harness.recover.mockClear();
  harness.off.mockClear();
});

describe('worktree transition resume recovery', () => {
  it.each([
    { lifecycle: 'closed' as const },
    { archivedAt: 10 },
  ])('recovers a startup-deferred transition after revival: %o', async (blocked) => {
    harness.session = session(blocked);
    startWorktreeTransitionResumeRecovery();
    harness.session = session();
    harness.listener?.(harness.session!);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.recover).toHaveBeenCalledWith('session-a');
  });

  it.each([
    'enter_waiting_tool_result',
    'interrupting_enter_turn',
    'switching_to_worktree',
  ] as const)(
    'does not mistake an ordinary active-session upsert during %s for revival',
    async (phase) => {
      harness.transition = null;
      startWorktreeTransitionResumeRecovery();
      harness.transition = transition(phase);
      harness.listener?.(harness.session!);
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.recover).not.toHaveBeenCalled();
    },
  );

  it('tracks a transition that becomes closed after startup and recovers it on revival', async () => {
    startWorktreeTransitionResumeRecovery();
    harness.session = session({ lifecycle: 'closed' });
    harness.listener?.(harness.session);
    harness.session = session();
    harness.listener?.(harness.session);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.recover).toHaveBeenCalledWith('session-a');
  });

  it('drops deferred state for a settled lease', async () => {
    harness.session = session({ lifecycle: 'closed' });
    startWorktreeTransitionResumeRecovery();
    harness.transition = transition('active');
    harness.session = session();
    harness.listener?.(harness.session!);
    await Promise.resolve();
    expect(harness.recover).not.toHaveBeenCalled();
  });
});
