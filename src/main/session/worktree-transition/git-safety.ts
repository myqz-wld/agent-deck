export type WorktreeGitRunner = (
  args: string[],
  cwd: string,
) => Promise<string>;

export class DirtyWorktreeError extends Error {
  readonly status: string;

  constructor(status: string) {
    const lines = status.trim().split('\n');
    super(
      `worktree has uncommitted changes: ${lines.slice(0, 3).join(' / ')}${
        lines.length > 3 ? ' ...' : ''
      }`,
    );
    this.name = 'DirtyWorktreeError';
    this.status = status;
  }
}

export class UnreferencedWorktreeHeadError extends Error {
  readonly headCommit: string;

  constructor(headCommit: string) {
    super(
      `worktree HEAD ${headCommit} is not reachable from any local branch, ` +
        'remote-tracking branch, or tag.',
    );
    this.name = 'UnreferencedWorktreeHeadError';
    this.headCommit = headCommit;
  }
}

export async function assertWorktreeClean(
  runGit: WorktreeGitRunner,
  worktreePath: string,
): Promise<void> {
  const status = await runGit(
    ['status', '--porcelain', '--untracked-files=all'],
    worktreePath,
  );
  if (status.trim()) throw new DirtyWorktreeError(status);
}

/**
 * Removing a clean detached worktree can still strand commits. Require HEAD to be reachable from
 * any durable ref without coupling the lease to a particular branch name or mutating that ref.
 */
export async function assertWorktreeHeadIsReferenced(
  runGit: WorktreeGitRunner,
  worktreePath: string,
): Promise<string> {
  const headCommit = (
    await runGit(
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      worktreePath,
    )
  ).trim();
  if (!headCommit) {
    throw new Error(
      `git rev-parse returned an empty HEAD commit for worktree ${worktreePath}.`,
    );
  }
  const containingRefs = await runGit(
    [
      'for-each-ref',
      '--format=%(refname)',
      '--contains',
      headCommit,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    worktreePath,
  );
  if (!containingRefs.trim()) {
    throw new UnreferencedWorktreeHeadError(headCommit);
  }
  return headCommit;
}
