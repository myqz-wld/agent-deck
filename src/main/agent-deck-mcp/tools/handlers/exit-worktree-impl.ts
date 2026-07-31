import * as path from 'node:path';

import {
  existsSyncDefault,
  realpathSyncDefault,
  runGitDefault,
} from './_shared/default-impl-deps';
import {
  assertWorktreeClean,
  assertWorktreeHeadIsReferenced,
  DirtyWorktreeError,
  UnreferencedWorktreeHeadError,
} from '@main/session/worktree-transition/git-safety';

const LEGACY_EXIT_PREFLIGHT_GIT_TIMEOUT_MS = 30_000;

export interface ExitWorktreeInput {
  callerSessionId: string;
  worktreePathOverride?: string;
  discardChanges?: boolean;
}

export interface PreparedLegacyWorktreeExit {
  kind: 'ready';
  expectedMarker: string | null;
  originalCwd: string;
  mainRepo: string;
  worktreePath: string;
  headCommit: string;
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

function dirtyWorktreeError(error: DirtyWorktreeError): ExitWorktreeError {
  return {
    error: error.message,
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

  let headCommit: string;
  try {
    headCommit = await assertWorktreeHeadIsReferenced(
      deps.runGit,
      worktreePath,
    );
  } catch (error) {
    if (error instanceof UnreferencedWorktreeHeadError) {
      return {
        error: error.message,
        hint:
          'Create a local branch or tag that contains this HEAD commit, then retry. ' +
          'discardChanges does not authorize losing commits, and no marker or Git ref was changed.',
        markerCleared: false,
      };
    }
    return {
      error: `Git HEAD safety check failed in legacy worktree: ${
        error instanceof Error ? error.message : String(error)
      }`,
      hint:
        'Repair the registered worktree before retrying. The marker and directory were retained.',
      markerCleared: false,
    };
  }

  if (!input.discardChanges) {
    try {
      await assertWorktreeClean(deps.runGit, worktreePath);
    } catch (error) {
      if (error instanceof DirtyWorktreeError) {
        return dirtyWorktreeError(error);
      }
      return {
        error: `Git dirty-state check failed in legacy worktree: ${
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
    headCommit,
  };
}

export const _internalIsError = isError;
