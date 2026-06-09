import * as path from 'node:path';

import {
  existsDefault,
  realpathDefault,
  runGitDefault,
} from './_shared/default-impl-deps';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

export interface ExitWorktreeInput {
  callerSessionId: string;
  worktreePathOverride?: string;
  discardChanges?: boolean;
  deleteBranch?: boolean;
}

export interface ExitWorktreeImplResult {
  worktreePath: string;
  workBranch: string | null;
  branchDeleted: boolean;
  worktreeRemoved: boolean;
  markerCleared: boolean;
}

export type ExitWorktreeError = {
  error: string;
  hint?: string;
  markerCleared?: boolean;
};

export interface ExitWorktreeDeps {
  runGit?: (args: string[], cwd: string) => Promise<string>;
  exists?: (p: string) => Promise<boolean>;
  realpath?: (p: string) => Promise<string>;
  callerMarker?: (callerSid: string) => string | null;
  clearCwdReleaseMarker?: (sid: string) => void;
}

const DEFAULT_DEPS: Required<ExitWorktreeDeps> = {
  runGit: runGitDefault,
  exists: existsDefault,
  realpath: realpathDefault,
  callerMarker: (_sid: string) => {
    throw new Error('exit-worktree-impl: deps.callerMarker not injected.');
  },
  clearCwdReleaseMarker: (_sid: string) => {
    throw new Error('exit-worktree-impl: deps.clearCwdReleaseMarker not injected.');
  },
};

function isError(x: unknown): x is ExitWorktreeError {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { error?: unknown }).error === 'string'
  );
}

function stripTrailingSlash(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

async function normalizePath(p: string, deps: Required<ExitWorktreeDeps>): Promise<string> {
  try {
    return stripTrailingSlash(await deps.realpath(p));
  } catch {
    return stripTrailingSlash(p);
  }
}

function clearMarker(
  deps: Required<ExitWorktreeDeps>,
  callerSessionId: string,
): boolean | ExitWorktreeError {
  try {
    deps.clearCwdReleaseMarker(callerSessionId);
    return true;
  } catch (e) {
    return {
      error: `clearCwdReleaseMarker failed: ${(e as Error).message}`,
      hint: 'Worktree cleanup may have completed, but the caller still holds a stale worktree marker. Retry exit_worktree after checking the marker, or close the session to clear it.',
      markerCleared: false,
    };
  }
}

export async function exitWorktreeImpl(
  input: ExitWorktreeInput,
  depsOverride?: ExitWorktreeDeps,
): Promise<ExitWorktreeImplResult | ExitWorktreeError> {
  const deps: Required<ExitWorktreeDeps> = { ...DEFAULT_DEPS, ...depsOverride };
  const marker = deps.callerMarker(input.callerSessionId);
  const worktreePath = input.worktreePathOverride ?? marker;
  if (!worktreePath) {
    return {
      error: 'cannot resolve worktreePath: caller has no worktree marker and no worktreePath override',
      hint: 'Pass worktreePath explicitly, or call enter_worktree first so the session owns a worktree marker.',
    };
  }

  if (input.worktreePathOverride && marker) {
    const argPath = await normalizePath(input.worktreePathOverride, deps);
    const markerPath = await normalizePath(marker, deps);
    if (argPath !== markerPath) {
      return {
        error: `args.worktreePath (${input.worktreePathOverride}) does not match caller marker (${marker})`,
        hint: 'A session may only exit the worktree it currently owns. Omit worktreePath to use the marker, or preserve current work and close that marker first.',
      };
    }
  }

  if (!(await deps.exists(worktreePath))) {
    let markerCleared = false;
    if (marker) {
      const cleared = clearMarker(deps, input.callerSessionId);
      if (isError(cleared)) return cleared;
      markerCleared = cleared;
    }
    return {
      worktreePath,
      workBranch: null,
      branchDeleted: false,
      worktreeRemoved: false,
      markerCleared,
    };
  }

  let mainRepo: string;
  try {
    const gitCommonDir = await deps.runGit(['rev-parse', '--git-common-dir'], worktreePath);
    const commonDirAbs = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(worktreePath, gitCommonDir);
    mainRepo = path.dirname(commonDirAbs);
  } catch (e) {
    return {
      error: `git rev-parse --git-common-dir failed in worktree ${worktreePath}: ${(e as Error).message}`,
      hint: 'The directory exists but does not look like a valid git worktree. Preserve any files you need, repair/prune the git worktree manually, then retry to clear the marker.',
      markerCleared: false,
    };
  }

  let workBranch: string | null = null;
  try {
    const branch = await deps.runGit(['branch', '--show-current'], worktreePath);
    workBranch = branch.trim() || null;
  } catch {
    workBranch = null;
  }

  if (!input.discardChanges) {
    try {
      const status = await deps.runGit(['status', '--porcelain'], worktreePath);
      if (status.trim().length > 0) {
        return {
          error: `worktree has uncommitted changes: ${status.split('\n').slice(0, 3).join(' / ')}${status.split('\n').length > 3 ? ' ...' : ''}`,
          hint: 'Do not lose user work. Commit, stash, copy, or otherwise preserve these changes before exiting. Pass discardChanges=true only when the user explicitly wants to abandon uncommitted changes.',
          markerCleared: false,
        };
      }
    } catch (e) {
      return {
        error: `git status --porcelain failed in worktree: ${(e as Error).message}`,
        hint: 'Preserve any needed changes before retrying. The marker was not cleared.',
        markerCleared: false,
      };
    }
  }

  try {
    const args = input.discardChanges
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath];
    await deps.runGit(args, mainRepo);
  } catch (e) {
    return {
      error: `git worktree remove failed: ${(e as Error).message}`,
      hint: 'The worktree directory was not removed and the marker was not cleared. Preserve needed changes, then retry or pass discardChanges=true only to abandon them.',
      markerCleared: false,
    };
  }

  let branchDeleted = false;
  if (input.deleteBranch === true && workBranch && !PROTECTED_BRANCHES.has(workBranch)) {
    try {
      await deps.runGit(['branch', input.discardChanges ? '-D' : '-d', workBranch], mainRepo);
      branchDeleted = true;
    } catch (e) {
      const cleared = clearMarker(deps, input.callerSessionId);
      if (isError(cleared)) return cleared;
      return {
        error: `git branch ${input.discardChanges ? '-D' : '-d'} ${workBranch} failed: ${(e as Error).message}`,
        hint: input.discardChanges
          ? 'The worktree directory was removed and marker was cleared, but branch deletion failed. Inspect the branch manually before deleting it.'
          : 'The worktree directory was removed and marker was cleared. The branch was kept because it may contain unmerged commits; merge, cherry-pick, or intentionally delete it later.',
        markerCleared: true,
      };
    }
  }

  const cleared = clearMarker(deps, input.callerSessionId);
  if (isError(cleared)) return cleared;

  return {
    worktreePath,
    workBranch,
    branchDeleted,
    worktreeRemoved: true,
    markerCleared: cleared,
  };
}

export const _internalIsError = isError;
