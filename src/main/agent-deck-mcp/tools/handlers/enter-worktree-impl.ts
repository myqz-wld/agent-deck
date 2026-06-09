import * as path from 'node:path';

import {
  existsDefault,
  mkdirDefault,
  runGitDefault,
} from './_shared/default-impl-deps';

export interface EnterWorktreeInput {
  callerSessionId: string;
  baseBranch: string;
  workBranchOverride?: string;
  worktreePathOverride?: string;
  worktreeRootOverride?: string;
}

export interface EnterWorktreeImplResult {
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  baseCommit: string;
  baseSource: 'base-branch';
  markerSet: boolean;
}

export type EnterWorktreeError = { error: string; hint?: string };

export interface EnterWorktreeDeps {
  runGit?: (args: string[], cwd: string) => Promise<string>;
  exists?: (p: string) => Promise<boolean>;
  mkdir?: (p: string) => Promise<void>;
  callerCwd?: (callerSid: string) => string | null;
  setCwdReleaseMarker?: (sid: string, marker: string) => void;
  now?: () => number;
}

const DEFAULT_DEPS: Required<EnterWorktreeDeps> = {
  runGit: runGitDefault,
  exists: existsDefault,
  mkdir: mkdirDefault,
  callerCwd: (_sid: string) => {
    throw new Error('enter-worktree-impl: deps.callerCwd not injected.');
  },
  setCwdReleaseMarker: (_sid: string, _marker: string) => {
    throw new Error('enter-worktree-impl: deps.setCwdReleaseMarker not injected.');
  },
  now: () => Date.now(),
};

function isError(x: unknown): x is EnterWorktreeError {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { error?: unknown }).error === 'string'
  );
}

function isPlainLocalBranchName(name: string): boolean {
  return (
    name.trim() === name &&
    name.length > 0 &&
    !name.startsWith('-') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.includes('^') &&
    !name.includes('~') &&
    !name.includes(':') &&
    !name.includes('?') &&
    !name.includes('*') &&
    !name.includes('[') &&
    !name.includes('\\') &&
    !/\s/.test(name)
  );
}

function slugForPath(value: string): string {
  return value.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-');
}

async function resolveMainRepo(
  callerCwd: string,
  deps: Required<EnterWorktreeDeps>,
): Promise<string | EnterWorktreeError> {
  try {
    const gitCommonDir = await deps.runGit(['rev-parse', '--git-common-dir'], callerCwd);
    const commonDirAbs = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(callerCwd, gitCommonDir);
    return path.dirname(commonDirAbs);
  } catch (e) {
    return {
      error: `caller cwd is not inside a git repo: ${callerCwd}`,
      hint: `enter_worktree derives the main repo from the caller session cwd with git rev-parse --git-common-dir. Start from a git repo session or pass worktree operations through a session whose cwd is in the repo.`,
    };
  }
}

async function resolveBaseCommit(
  baseBranch: string,
  mainRepo: string,
  deps: Required<EnterWorktreeDeps>,
): Promise<string | EnterWorktreeError> {
  if (!isPlainLocalBranchName(baseBranch)) {
    return {
      error: `baseBranch must be a plain local branch name: ${baseBranch}`,
      hint: 'Pass a branch name like main or feature/x. SHA, tag, rev syntax, whitespace, and ref expressions are rejected.',
    };
  }
  try {
    await deps.runGit(['check-ref-format', '--branch', baseBranch], mainRepo);
  } catch (e) {
    return {
      error: `baseBranch is not a valid branch name: ${baseBranch}`,
      hint: `git check-ref-format --branch rejected the name. Pass an existing local branch name, not a commit or tag.`,
    };
  }
  try {
    const commit = await deps.runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}^{commit}`],
      mainRepo,
    );
    if (!commit) {
      return {
        error: `baseBranch does not resolve to a local branch commit: ${baseBranch}`,
        hint: `Create or fetch the local branch first, then retry. Verify with git -C ${mainRepo} branch --list ${baseBranch}.`,
      };
    }
    return commit;
  } catch (e) {
    return {
      error: `baseBranch does not resolve to a local branch commit: ${baseBranch}`,
      hint: `enter_worktree resolves refs/heads/${baseBranch}; SHA, tag, and remote-only refs are not accepted.`,
    };
  }
}

async function rollbackCreatedWorktree(input: {
  deps: Required<EnterWorktreeDeps>;
  mainRepo: string;
  worktreePath: string;
  workBranch: string;
}): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await input.deps.runGit(['worktree', 'remove', '--force', input.worktreePath], input.mainRepo);
  } catch (e) {
    warnings.push(`git worktree remove --force failed: ${(e as Error).message}`);
  }
  try {
    await input.deps.runGit(['branch', '-D', input.workBranch], input.mainRepo);
  } catch (e) {
    warnings.push(`git branch -D ${input.workBranch} failed: ${(e as Error).message}`);
  }
  return warnings;
}

export async function enterWorktreeImpl(
  input: EnterWorktreeInput,
  depsOverride?: EnterWorktreeDeps,
): Promise<EnterWorktreeImplResult | EnterWorktreeError> {
  const deps: Required<EnterWorktreeDeps> = { ...DEFAULT_DEPS, ...depsOverride };

  const callerCwd = deps.callerCwd(input.callerSessionId);
  if (!callerCwd) {
    return {
      error: `caller session ${input.callerSessionId} has no cwd`,
      hint: 'enter_worktree requires a real Agent Deck session so it can derive the repo and store the worktree marker.',
    };
  }

  const mainRepo = await resolveMainRepo(callerCwd, deps);
  if (isError(mainRepo)) return mainRepo;

  const baseCommit = await resolveBaseCommit(input.baseBranch, mainRepo, deps);
  if (isError(baseCommit)) return baseCommit;

  const derivedBranch =
    input.workBranchOverride ??
    `agent-deck/${slugForPath(input.baseBranch)}-${input.callerSessionId.slice(0, 8)}-${deps
      .now()
      .toString(36)}`;
  const workBranch = derivedBranch;
  const worktreeRoot = input.worktreeRootOverride ?? path.join(mainRepo, '.agent-deck', 'worktrees');
  const worktreePath =
    input.worktreePathOverride ?? path.join(worktreeRoot, slugForPath(workBranch));

  if (await deps.exists(worktreePath)) {
    return {
      error: `worktreePath already exists: ${worktreePath}`,
      hint: 'Choose a new workBranch or worktreePath. enter_worktree creates a fresh worktree and does not attach to an existing directory.',
    };
  }

  try {
    const branchExists = await deps.runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${workBranch}`],
      mainRepo,
    );
    if (branchExists) {
      return {
        error: `workBranch already exists: ${workBranch}`,
        hint: 'Choose a new workBranch or delete the stale branch after preserving any needed commits.',
      };
    }
  } catch {
    // rev-parse --verify exits non-zero when the branch does not exist; that is the desired path.
  }

  try {
    await deps.runGit(['check-ref-format', '--branch', workBranch], mainRepo);
  } catch {
    return {
      error: `workBranch is not a valid branch name: ${workBranch}`,
      hint: 'Pass a valid branch name, for example agent-deck/my-task.',
    };
  }

  await deps.mkdir(path.dirname(worktreePath));

  try {
    await deps.runGit(['worktree', 'add', '-b', workBranch, worktreePath, baseCommit], mainRepo);
  } catch (e) {
    return {
      error: `git worktree add failed: ${(e as Error).message}`,
      hint: `Verify baseBranch "${input.baseBranch}" is available and worktreePath parent is writable: ${path.dirname(worktreePath)}`,
    };
  }

  try {
    deps.setCwdReleaseMarker(input.callerSessionId, worktreePath);
  } catch (e) {
    const warnings = await rollbackCreatedWorktree({ deps, mainRepo, worktreePath, workBranch });
    return {
      error: `setCwdReleaseMarker failed after worktree creation: ${(e as Error).message}`,
      hint:
        warnings.length > 0
          ? `Rollback was incomplete: ${warnings.join('; ')}`
          : 'Created worktree and branch were rolled back.',
    };
  }

  return {
    worktreePath,
    workBranch,
    baseBranch: input.baseBranch,
    baseCommit,
    baseSource: 'base-branch',
    markerSet: true,
  };
}

export const _internalIsError = isError;
