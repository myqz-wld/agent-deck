import { isAbsolute, normalize, resolve } from 'node:path';

type RunGit = (args: string[], cwd: string) => Promise<string>;

/** Resolve a working directory instead of inferring it from Git's metadata directory layout. */
export async function readGitMainWorktree(cwd: string, runGit: RunGit): Promise<string> {
  const listing = await runGit(['worktree', 'list', '--porcelain', '-z'], cwd);
  const end = listing.indexOf('\0');
  const first = end < 0 ? '' : listing.slice(0, end);
  const mainEntry = first.startsWith('worktree ') ? first.slice('worktree '.length) : '';
  if (!mainEntry || !isAbsolute(mainEntry)) {
    throw new Error('Git did not report an absolute main worktree path.');
  }
  // A submodule's first entry can be its metadata directory. Git's core.worktree resolves
  // that entry to the real checkout. A separate Git directory may have no such reverse link;
  // the caller's verified checkout remains a valid owner for worktree operations in that case.
  let root: string;
  try {
    root = await runGit(['rev-parse', '--show-toplevel'], mainEntry);
  } catch {
    root = await runGit(['rev-parse', '--show-toplevel'], cwd);
  }
  if (!root || !isAbsolute(root) || root.includes('\0')) {
    throw new Error('Git did not report an absolute repository checkout.');
  }
  return normalize(root);
}

/** Worktrees share this identity even when their checkout directories and HEAD refs differ. */
export async function readGitCommonDirectory(cwd: string, runGit: RunGit): Promise<string> {
  const common = await runGit(['rev-parse', '--git-common-dir'], cwd);
  if (!common || common.includes('\0')) throw new Error('Git repository identity is missing.');
  return resolve(cwd, common);
}
