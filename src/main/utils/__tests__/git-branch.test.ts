import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectGitBranchName } from '../git-branch';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('detectGitBranchName', () => {
  it('returns null for null cwd', () => {
    expect(detectGitBranchName(null)).toBeNull();
  });

  it('returns null outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-deck-non-git-'));
    try {
      expect(detectGitBranchName(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!gitAvailable)('detectGitBranchName / git-backed cases', () => {
  it('returns the current branch for normal branch names', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-deck-git-branch-'));
    try {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feature/branch-snapshot'], { cwd: repo, stdio: 'ignore' });

      expect(detectGitBranchName(repo)).toBe('feature/branch-snapshot');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns null for valid branches longer than the issue DB limit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-deck-git-branch-'));
    const longBranch = `${'a'.repeat(100)}/${'b'.repeat(100)}/${'c'.repeat(100)}`;
    try {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', longBranch], { cwd: repo, stdio: 'ignore' });

      expect(longBranch.length).toBeGreaterThan(255);
      expect(detectGitBranchName(repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
