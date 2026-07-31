import { describe, expect, it } from 'vitest';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';
import type { SessionRecord } from '@shared/types';
import { validateWorktreeHandOffPreflight } from '../tools/handlers/hand-off-session/worktree-preflight';

function source(cwd = '/repo'): SessionRecord {
  return {
    id: 'caller-sid',
    agentId: 'codex-cli',
    cwd,
  } as SessionRecord;
}

function transition(
  phase: WorktreeTransitionRecord['phase'],
): WorktreeTransitionRecord {
  return {
    sessionId: 'caller-sid',
    generation: 2,
    direction: phase === 'active' ? 'enter' : 'exit',
    phase,
    originalCwd: '/repo',
    targetCwd: phase === 'active' ? '/repo/worktree' : '/repo',
    mainRepo: '/repo',
    worktreePath: '/repo/worktree',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-a',
    continuationKey: 'cwd:test:2',
    continuationDelivered: phase === 'active',
    discardChanges: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

describe('handoff worktree preflight', () => {
  it('rejects a pending cwd transition before successor preparation', () => {
    const error = validateWorktreeHandOffPreflight({
      source: source(),
      finalCwd: '/repo',
      deps: {
        worktreeTransition: () =>
          transition('exit_waiting_tool_result'),
      },
    });
    expect(error?.error).toContain('worktree cwd transition is still pending');
  });

  it('rejects an active lease when the live runtime cwd disagrees', () => {
    const error = validateWorktreeHandOffPreflight({
      source: source('/repo/worktree'),
      finalCwd: '/repo/worktree',
      deps: {
        worktreeTransition: () => transition('active'),
        sourceRuntimeCwd: () => '/repo',
      },
    });
    expect(error?.error).toContain('active worktree lease cwd mismatch');
  });

  it('accepts an active lease only when persisted, target, and runtime cwd agree', () => {
    expect(
      validateWorktreeHandOffPreflight({
        source: source('/repo/worktree'),
        finalCwd: '/repo/worktree',
        deps: {
          worktreeTransition: () => transition('active'),
          sourceRuntimeCwd: () => '/repo/worktree',
        },
      }),
    ).toBeNull();
  });
});
