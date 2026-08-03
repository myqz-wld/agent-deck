import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeTransitionRecord } from '../types';

const harness = vi.hoisted(() => ({
  append: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@main/store/db', () => ({ isDbInitialized: () => true }));
vi.mock('@main/store/worktree-transition-repo', () => ({
  worktreeTransitionRepo: { get: () => transition() },
}));
vi.mock('@main/store/worktree-transition-input-repo', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@main/store/worktree-transition-input-repo')
  >();
  return {
    ...original,
    worktreeTransitionInputRepo: { append: harness.append },
  };
});

import { WorktreeTransitionInputClosedError } from '@main/store/worktree-transition-input-repo';
import { guardWorktreeTransitionIngress } from '../ingress-guard';

function transition(): WorktreeTransitionRecord {
  return {
    sessionId: 'session-a',
    generation: 3,
    direction: 'enter',
    phase: 'switching_to_worktree',
    originalCwd: '/repo',
    targetCwd: '/repo/worktree',
    mainRepo: '/repo',
    worktreePath: '/repo/worktree',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-enter',
    continuationKey: 'cwd:test:3',
    continuationDelivered: true,
    discardChanges: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

beforeEach(() => {
  harness.append.mockReset();
  harness.emit.mockClear();
});

describe('worktree transition ingress guard', () => {
  it('falls through to the live adapter when the buffer seals after its optimistic read', () => {
    harness.append.mockImplementation(() => {
      throw new WorktreeTransitionInputClosedError('session-a', 3);
    });

    expect(guardWorktreeTransitionIngress({
      sessionId: 'session-a',
      agentId: 'codex-cli',
      text: 'arrived at seal',
      emit: harness.emit,
    })).toBe(false);
    expect(harness.emit).not.toHaveBeenCalled();
  });
});
