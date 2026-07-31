import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorktreeTransitionRecord } from '../types';
import {
  isSameOrInsideWorktreePath,
  preflightStructuredWorktreeExit,
} from '../git-cleanup';

function createWorktreeFixture(): {
  root: string;
  mainRepo: string;
  worktreePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-worktree-cleanup-'));
  const mainRepo = join(root, 'repo');
  const worktreePath = join(root, 'worktree');
  mkdirSync(mainRepo);
  execFileSync('git', ['init', '-b', 'main'], {
    cwd: mainRepo,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: mainRepo,
  });
  execFileSync('git', ['config', 'user.name', 'Agent Deck Test'], {
    cwd: mainRepo,
  });
  writeFileSync(join(mainRepo, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: mainRepo });
  execFileSync('git', ['commit', '-m', 'baseline'], {
    cwd: mainRepo,
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    ['worktree', 'add', '-b', 'leased-branch', worktreePath, 'main'],
    { cwd: mainRepo, stdio: 'ignore' },
  );
  return {
    root,
    mainRepo: realpathSync.native(mainRepo),
    worktreePath: realpathSync.native(worktreePath),
  };
}

function transition(
  mainRepo: string,
  worktreePath: string,
): WorktreeTransitionRecord {
  return {
    sessionId: 'session-a',
    generation: 1,
    direction: 'enter',
    phase: 'active',
    originalCwd: mainRepo,
    targetCwd: worktreePath,
    mainRepo,
    worktreePath,
    baseCommit: 'a'.repeat(40),
    toolUseId: null,
    continuationKey: 'worktree:test',
    continuationDelivered: true,
    discardChanges: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

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

  it('accepts a clean worktree after its branch is renamed', async () => {
    const fixture = createWorktreeFixture();
    try {
      execFileSync('git', ['branch', '-m', 'renamed-branch'], {
        cwd: fixture.worktreePath,
      });
      await expect(
        preflightStructuredWorktreeExit(
          transition(fixture.mainRepo, fixture.worktreePath),
          { discardChanges: false },
        ),
      ).resolves.toEqual({ exists: true });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a clean detached HEAD commit that has no durable ref', async () => {
    const fixture = createWorktreeFixture();
    try {
      execFileSync('git', ['switch', '--detach'], {
        cwd: fixture.worktreePath,
        stdio: 'ignore',
      });
      writeFileSync(join(fixture.worktreePath, 'tracked.txt'), 'detached\n');
      execFileSync('git', ['add', 'tracked.txt'], {
        cwd: fixture.worktreePath,
      });
      execFileSync('git', ['commit', '-m', 'detached'], {
        cwd: fixture.worktreePath,
        stdio: 'ignore',
      });
      await expect(
        preflightStructuredWorktreeExit(
          transition(fixture.mainRepo, fixture.worktreePath),
          { discardChanges: true },
        ),
      ).rejects.toThrow('not reachable from any local branch');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
