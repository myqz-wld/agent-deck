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

export interface PreparedEnterWorktree {
  callerSessionId: string;
  originalCwd: string;
  mainRepo: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  baseCommit: string;
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
  baseCommit: string;
}): Promise<string[]> {
  const warnings: string[] = [];
  if (await input.deps.exists(input.worktreePath)) {
    try {
      const status = await input.deps.runGit(
        ['status', '--porcelain'],
        input.worktreePath,
      );
      if (status.trim()) {
        warnings.push(
          `created worktree became dirty and was retained: ${status
            .split('\n')
            .slice(0, 3)
            .join(' / ')}`,
        );
      } else {
        await input.deps.runGit(
          ['worktree', 'remove', input.worktreePath],
          input.mainRepo,
        );
      }
    } catch (e) {
      warnings.push(`git worktree remove failed: ${(e as Error).message}`);
    }
  }

  let branchTip: string | null = null;
  try {
    branchTip = (
      await input.deps.runGit(
        [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${input.workBranch}^{commit}`,
        ],
        input.mainRepo,
      )
    ).trim() || null;
  } catch {
    // git worktree add may have failed before creating the branch.
  }
  if (!branchTip) return warnings;
  if (branchTip !== input.baseCommit) {
    warnings.push(
      `generated branch ${input.workBranch} moved from the base commit and was retained`,
    );
    return warnings;
  }
  if (await input.deps.exists(input.worktreePath)) {
    warnings.push(
      `generated branch ${input.workBranch} was retained because the worktree path still exists`,
    );
    return warnings;
  }
  try {
    await input.deps.runGit(
      ['branch', '-d', input.workBranch],
      input.mainRepo,
    );
  } catch (e) {
    warnings.push(
      `git branch -d ${input.workBranch} failed: ${(e as Error).message}`,
    );
  }
  return warnings;
}

/** Read-only git/path validation plus parent creation. No worktree or branch exists on success. */
export async function prepareEnterWorktree(
  input: EnterWorktreeInput,
  depsOverride?: EnterWorktreeDeps,
): Promise<PreparedEnterWorktree | EnterWorktreeError> {
  const deps: Required<EnterWorktreeDeps> = {
    ...DEFAULT_DEPS,
    ...depsOverride,
  };
  const callerCwd = deps.callerCwd(input.callerSessionId);
  if (!callerCwd) {
    return {
      error: `caller session ${input.callerSessionId} has no cwd`,
      hint: 'enter_worktree requires a real Agent Deck session so it can derive the repo and persist automatic cwd transition state.',
    };
  }
  const mainRepo = await resolveMainRepo(callerCwd, deps);
  if (isError(mainRepo)) return mainRepo;
  const baseCommit = await resolveBaseCommit(
    input.baseBranch,
    mainRepo,
    deps,
  );
  if (isError(baseCommit)) return baseCommit;
  const workBranch =
    input.workBranchOverride ??
    `agent-deck/${slugForPath(input.baseBranch)}-${input.callerSessionId.slice(
      0,
      8,
    )}-${deps.now().toString(36)}`;
  const worktreeRoot =
    input.worktreeRootOverride ??
    path.join(mainRepo, '.agent-deck', 'worktrees');
  const worktreePath =
    input.worktreePathOverride ??
    path.join(worktreeRoot, slugForPath(workBranch));
  if (await deps.exists(worktreePath)) {
    return {
      error: `worktreePath already exists: ${worktreePath}`,
      hint: 'Choose a new workBranch or worktreePath. enter_worktree creates a fresh worktree and does not attach to an existing directory.',
    };
  }
  try {
    const branchExists = await deps.runGit(
      [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${workBranch}`,
      ],
      mainRepo,
    );
    if (branchExists) {
      return {
        error: `workBranch already exists: ${workBranch}`,
        hint: 'Choose a new workBranch or delete the stale branch after preserving any needed commits.',
      };
    }
  } catch {
    // rev-parse exits non-zero when the branch is absent.
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
  return {
    callerSessionId: input.callerSessionId,
    originalCwd: callerCwd,
    mainRepo,
    worktreePath,
    workBranch,
    baseBranch: input.baseBranch,
    baseCommit,
  };
}

export async function createPreparedWorktree(
  prepared: PreparedEnterWorktree,
  depsOverride?: EnterWorktreeDeps,
): Promise<void> {
  const deps: Required<EnterWorktreeDeps> = {
    ...DEFAULT_DEPS,
    ...depsOverride,
  };
  await deps.runGit(
    [
      'worktree',
      'add',
      '-b',
      prepared.workBranch,
      prepared.worktreePath,
      prepared.baseCommit,
    ],
    prepared.mainRepo,
  );
}

export async function rollbackPreparedWorktree(
  prepared: PreparedEnterWorktree,
  depsOverride?: EnterWorktreeDeps,
): Promise<string[]> {
  const deps: Required<EnterWorktreeDeps> = {
    ...DEFAULT_DEPS,
    ...depsOverride,
  };
  return rollbackCreatedWorktree({
    deps,
    mainRepo: prepared.mainRepo,
    worktreePath: prepared.worktreePath,
    workBranch: prepared.workBranch,
    baseCommit: prepared.baseCommit,
  });
}

export async function enterWorktreeImpl(
  input: EnterWorktreeInput,
  depsOverride?: EnterWorktreeDeps,
): Promise<EnterWorktreeImplResult | EnterWorktreeError> {
  const deps: Required<EnterWorktreeDeps> = {
    ...DEFAULT_DEPS,
    ...depsOverride,
  };
  const prepared = await prepareEnterWorktree(input, deps);
  if (isError(prepared)) return prepared;
  try {
    await createPreparedWorktree(prepared, deps);
  } catch (e) {
    return {
      error: `git worktree add failed: ${(e as Error).message}`,
      hint: `Verify baseBranch "${input.baseBranch}" is available and worktreePath parent is writable: ${path.dirname(prepared.worktreePath)}`,
    };
  }
  try {
    deps.setCwdReleaseMarker(
      input.callerSessionId,
      prepared.worktreePath,
    );
  } catch (e) {
    const warnings = await rollbackPreparedWorktree(prepared, deps);
    return {
      error: `setCwdReleaseMarker failed after worktree creation: ${(e as Error).message}`,
      hint:
        warnings.length > 0
          ? `Rollback was incomplete: ${warnings.join('; ')}`
          : 'Created worktree and branch were rolled back.',
    };
  }

  return {
    worktreePath: prepared.worktreePath,
    workBranch: prepared.workBranch,
    baseBranch: prepared.baseBranch,
    baseCommit: prepared.baseCommit,
    baseSource: 'base-branch',
    markerSet: true,
  };
}

export const _internalIsError = isError;
