import * as path from 'node:path';

import {
  existsSyncDefault,
  realpathSyncDefault,
  runGitDefault,
} from './_shared/default-impl-deps';

const LEGACY_EXIT_PREFLIGHT_GIT_TIMEOUT_MS = 30_000;

export interface ExitWorktreeInput {
  callerSessionId: string;
  worktreePathOverride?: string;
  discardChanges?: boolean;
  deleteBranch?: boolean;
}

export interface PreparedLegacyWorktreeExit {
  kind: 'ready';
  expectedMarker: string | null;
  originalCwd: string;
  mainRepo: string;
  worktreePath: string;
  /** Empty means the legacy worktree is detached. */
  workBranch: string;
  baseBranch: string;
  baseCommit: string;
}

export interface MissingLegacyWorktreeExit {
  kind: 'missing';
  worktreePath: string;
  markerCleared: boolean;
}

export type ExitWorktreeError = {
  error: string;
  hint?: string;
  markerCleared?: boolean;
};

export type LegacyWorktreeExitPreparation =
  | PreparedLegacyWorktreeExit
  | MissingLegacyWorktreeExit
  | ExitWorktreeError;

export interface ExitWorktreeDeps {
  runGit?: (args: string[], cwd: string) => Promise<string>;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  callerMarker?: (callerSid: string) => string | null;
  callerCwd?: (callerSid: string) => string | null;
  clearCwdReleaseMarker?: (sid: string) => void;
}

const DEFAULT_DEPS: Required<ExitWorktreeDeps> = {
  runGit: (args, cwd) =>
    runGitDefault(args, cwd, {
      timeoutMs: LEGACY_EXIT_PREFLIGHT_GIT_TIMEOUT_MS,
    }),
  exists: existsSyncDefault,
  realpath: realpathSyncDefault,
  callerMarker: (_sid: string) => {
    throw new Error('exit-worktree-impl: deps.callerMarker not injected.');
  },
  callerCwd: (_sid: string) => {
    throw new Error('exit-worktree-impl: deps.callerCwd not injected.');
  },
  clearCwdReleaseMarker: (_sid: string) => {
    throw new Error(
      'exit-worktree-impl: deps.clearCwdReleaseMarker not injected.',
    );
  },
};

function isError(value: unknown): value is ExitWorktreeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

function stripTrailingSlash(value: string): string {
  const stripped = value.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function resolvePath(value: string): string {
  return stripTrailingSlash(path.resolve(value));
}

function normalizePath(
  value: string,
  deps: Required<ExitWorktreeDeps>,
): string {
  try {
    return stripTrailingSlash(deps.realpath(value));
  } catch {
    return stripTrailingSlash(path.resolve(value));
  }
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function clearMarker(
  deps: Required<ExitWorktreeDeps>,
  callerSessionId: string,
): boolean | ExitWorktreeError {
  try {
    deps.clearCwdReleaseMarker(callerSessionId);
    return true;
  } catch (error) {
    return {
      error: `clearCwdReleaseMarker failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      hint:
        'The worktree path is already absent, but the caller still holds a stale marker. ' +
        'Retry exit_worktree after checking the marker, or close the session to clear it.',
      markerCleared: false,
    };
  }
}

function dirtyWorktreeError(status: string): ExitWorktreeError {
  const lines = status.split('\n');
  return {
    error: `worktree has uncommitted changes: ${lines
      .slice(0, 3)
      .join(' / ')}${lines.length > 3 ? ' ...' : ''}`,
    hint:
      'Do not lose user work. Commit, stash, copy, or otherwise preserve these changes before ' +
      'exiting. Pass discardChanges=true only when the user explicitly wants to abandon them.',
    markerCleared: false,
  };
}

/**
 * Read-only legacy compatibility preflight.
 *
 * Existing worktrees are never removed here. The handler persists them as a structured exit
 * before returning asynchronous acceptance. Synchronous path metadata removes the pre-Git async
 * filesystem-pool wait from this boundary, while every default Git command has a 30-second bound.
 */
export async function prepareLegacyWorktreeExit(
  input: ExitWorktreeInput,
  depsOverride?: ExitWorktreeDeps,
): Promise<LegacyWorktreeExitPreparation> {
  const deps: Required<ExitWorktreeDeps> = {
    ...DEFAULT_DEPS,
    ...depsOverride,
  };
  const marker = deps.callerMarker(input.callerSessionId);
  const requestedPath = input.worktreePathOverride ?? marker;
  if (!requestedPath) {
    return {
      error:
        'cannot resolve worktreePath: caller has no structured lease, legacy marker, or worktreePath override',
      hint:
        'Pass the exact registered worktreePath, or call enter_worktree first so the session owns a worktree lease.',
    };
  }

  if (
    input.worktreePathOverride &&
    marker &&
    resolvePath(input.worktreePathOverride) !== resolvePath(marker)
  ) {
    return {
      error: `args.worktreePath (${input.worktreePathOverride}) does not match caller marker (${marker})`,
      hint:
        'A session may only exit the worktree it currently owns. Omit worktreePath to use the marker, ' +
        'or preserve current work and close that marker first.',
      markerCleared: false,
    };
  }

  if (!deps.exists(requestedPath)) {
    let markerCleared = false;
    if (marker) {
      const cleared = clearMarker(deps, input.callerSessionId);
      if (isError(cleared)) return cleared;
      markerCleared = cleared;
    }
    return {
      kind: 'missing',
      worktreePath: requestedPath,
      markerCleared,
    };
  }

  const worktreePath = normalizePath(requestedPath, deps);
  let mainRepo: string;
  try {
    const common = await deps.runGit(
      ['rev-parse', '--git-common-dir'],
      worktreePath,
    );
    const absolute = path.isAbsolute(common)
      ? common
      : path.resolve(worktreePath, common);
    mainRepo = normalizePath(path.dirname(absolute), deps);
  } catch (error) {
    return {
      error: `git rev-parse --git-common-dir failed in worktree ${requestedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      hint:
        'The directory exists but is not a valid registered Git worktree. Preserve needed files, ' +
        'repair or prune its Git metadata, then retry. The marker was retained.',
      markerCleared: false,
    };
  }
  if (isSameOrInside(mainRepo, worktreePath)) {
    return {
      error: `refusing to adopt the main checkout as a removable worktree: ${requestedPath}`,
      hint:
        'Pass the linked worktree path, not the main repository checkout. No marker or Git state changed.',
      markerCleared: false,
    };
  }

  let workBranch = '';
  try {
    workBranch = (
      await deps.runGit(['branch', '--show-current'], worktreePath)
    ).trim();
  } catch {
    // Detached legacy worktrees intentionally use an empty persisted branch projection.
  }

  let baseCommit: string;
  try {
    baseCommit = (
      await deps.runGit(
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        worktreePath,
      )
    ).trim();
    if (!baseCommit) throw new Error('Git returned an empty HEAD commit.');
  } catch (error) {
    return {
      error: `git rev-parse HEAD failed in legacy worktree: ${
        error instanceof Error ? error.message : String(error)
      }`,
      hint:
        'Repair the registered worktree before retrying. The marker and directory were retained.',
      markerCleared: false,
    };
  }

  if (!input.discardChanges) {
    try {
      const status = await deps.runGit(
        ['status', '--porcelain'],
        worktreePath,
      );
      if (status.trim()) return dirtyWorktreeError(status);
    } catch (error) {
      return {
        error: `git status --porcelain failed in legacy worktree: ${
          error instanceof Error ? error.message : String(error)
        }`,
        hint:
          'Preserve any needed changes and retry. The marker and worktree were retained.',
        markerCleared: false,
      };
    }
  }

  const recordedCwd = deps.callerCwd(input.callerSessionId);
  const normalizedRecordedCwd =
    recordedCwd && deps.exists(recordedCwd)
      ? normalizePath(recordedCwd, deps)
      : null;
  const originalCwd =
    normalizedRecordedCwd &&
    !isSameOrInside(normalizedRecordedCwd, worktreePath)
      ? normalizedRecordedCwd
      : mainRepo;

  return {
    kind: 'ready',
    expectedMarker: marker,
    originalCwd,
    mainRepo,
    worktreePath,
    workBranch,
    baseBranch: workBranch || 'HEAD',
    baseCommit,
  };
}

export const _internalIsError = isError;
