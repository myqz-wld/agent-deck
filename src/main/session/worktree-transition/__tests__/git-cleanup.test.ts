import { describe, expect, it } from 'vitest';
import { isSameOrInsideWorktreePath } from '../git-cleanup';

describe('worktree cleanup path references', () => {
  it('treats the worktree and every descendant cwd as a live reference', () => {
    expect(
      isSameOrInsideWorktreePath('/repo/worktree', '/repo/worktree'),
    ).toBe(true);
    expect(
      isSameOrInsideWorktreePath('/repo/worktree/src', '/repo/worktree'),
    ).toBe(true);
    expect(
      isSameOrInsideWorktreePath('/repo/worktree-other', '/repo/worktree'),
    ).toBe(false);
    expect(
      isSameOrInsideWorktreePath('/repo', '/repo/worktree'),
    ).toBe(false);
  });
});
