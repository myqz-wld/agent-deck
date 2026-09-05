import * as path from 'node:path';

import {
  existsDefault,
  mkdirDefault,
  runGitDefault,
} from './_shared/default-impl-deps';
import {
  assertWorktreeClean,
  assertWorktreeHeadIsReferenced,
} from '@main/session/worktree-transition/git-safety';
import { readGitMainWorktree } from '@main/session/worktree-transition/git-repository';

const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ENTER_GIT_CHECK_TIMEOUT_MS = 30_000;
const ENTER_WORKTREE_MUTATION_TIMEOUT_MS = 10 * 60_000;

export interface EnterWorktreeInput {
  callerSessionId: string;
  startPoint: string;
  worktreePathOverride?: string;
  worktreeRootOverride?: string;
}

export interface PreparedEnterWorktree {
  callerSessionId: string;
  originalCwd: string;
  mainRepo: string;
  worktreePath: string;
  startCommit: string;
}

export type EnterWorktreeError = { error: string; hint?: string };

export interface EnterWorktreeDeps {
  runGit?: (
    args: string[],
    cwd: string,
    options?: { timeoutMs?: number },
  ) => Promise<string>;
  exists?: (p: string) => Promise<boolean>;
  mkdir?: (p: string) => Promise<void>;
  callerCwd?: (callerSid: string) => string | null;
  now?: () => number;
}

const DEFAULT_DEPS: Required<EnterWorktreeDeps> = {
  runGit: runGitDefault,
  exists: existsDefault,
  mkdir: mkdirDefault,
  callerCwd: (_sid: string) => {
    throw new Error('enter-worktree-impl: deps.callerCwd not injected.');
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

function isValidStartPoint(value: string): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    !value.startsWith('-') &&
    !/[\s\u0000]/.test(value)
  );
}

function slugForPath(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

async function resolveMainRepo(
  callerCwd: string,
  deps: Required<EnterWorktreeDeps>,
): Promise<string | EnterWorktreeError> {
  try {
    return await readGitMainWorktree(callerCwd, (args, cwd) =>
      deps.runGit(args, cwd, { timeoutMs: ENTER_GIT_CHECK_TIMEOUT_MS }));
  } catch (e) {
    return {
      error: `caller cwd is not inside a git repo: ${callerCwd}`,
      hint: 'Start from a Git repository session whose git worktree list --porcelain -z reports a valid main worktree. The caller repository owns revision resolution and worktree creation.',
    };
  }
}

async function resolveStartCommit(
  startPoint: string,
  callerCwd: string,
  deps: Required<EnterWorktreeDeps>,
): Promise<string | EnterWorktreeError> {
  if (!isValidStartPoint(startPoint)) {
    return {
      error: `startPoint must be one non-empty Git revision without whitespace or a leading hyphen: ${JSON.stringify(
        startPoint,
      )}`,
      hint:
        'Pass one commit-ish such as HEAD, main, refs/tags/v1.0, origin/main, a commit id, or HEAD~1.',
    };
  }
  try {
    const commit = (
      await deps.runGit(
        [
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${startPoint}^{commit}`,
        ],
        callerCwd,
        { timeoutMs: ENTER_GIT_CHECK_TIMEOUT_MS },
      )
    ).trim();
    if (!FULL_GIT_OBJECT_ID.test(commit)) {
      return {
        error: `startPoint did not resolve to exactly one full commit object id: ${startPoint}`,
        hint:
          'Verify the revision in the caller repository, then pass exactly one commit-ish. No worktree or Git ref was created.',
      };
    }
    return commit;
  } catch {
    return {
      error: `startPoint did not resolve to exactly one full commit object id: ${startPoint}`,
      hint:
        'Verify the revision with git rev-parse --verify <startPoint>^{commit}, then retry. The tool accepts branches, tags, remote-tracking refs, commit ids, and revision expressions but never mutates the selected ref.',
    };
  }
}

async function rollbackCreatedWorktree(input: {
  deps: Required<EnterWorktreeDeps>;
  mainRepo: string;
  worktreePath: string;
}): Promise<string[]> {
  if (!(await input.deps.exists(input.worktreePath))) return [];
  const checkedRunGit = (args: string[], cwd: string) =>
    input.deps.runGit(
      args,
      cwd,
      { timeoutMs: ENTER_GIT_CHECK_TIMEOUT_MS },
    );
  try {
    await assertWorktreeClean(
      checkedRunGit,
      input.worktreePath,
    );
  } catch (error) {
    return [
      `created worktree was retained because its dirty-state check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  try {
    await assertWorktreeHeadIsReferenced(
      checkedRunGit,
      input.worktreePath,
    );
  } catch (error) {
    return [
      `created worktree was retained because its HEAD safety check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  try {
    await input.deps.runGit(
      ['worktree', 'remove', input.worktreePath],
      input.mainRepo,
      { timeoutMs: ENTER_WORKTREE_MUTATION_TIMEOUT_MS },
    );
    return [];
  } catch (error) {
    return [
      `git worktree remove failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

/** Read-only Git/path validation plus parent creation. No worktree or ref exists on success. */
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
  const startCommit = await resolveStartCommit(
    input.startPoint,
    callerCwd,
    deps,
  );
  if (isError(startCommit)) return startCommit;
  const sessionSlug =
    slugForPath(input.callerSessionId.slice(0, 12)) || 'session';
  const worktreeName =
    `agent-deck-${sessionSlug}-${deps.now().toString(36)}`;
  const worktreeRoot =
    input.worktreeRootOverride ??
    path.join(mainRepo, '.agent-deck', 'worktrees');
  const worktreePath =
    input.worktreePathOverride ??
    path.join(worktreeRoot, worktreeName);
  if (await deps.exists(worktreePath)) {
    return {
      error: `worktreePath already exists: ${worktreePath}`,
      hint:
        'Choose a different worktreePath or omit it to derive a new session/time-based path. The tool never attaches to or overwrites an existing directory.',
    };
  }
  await deps.mkdir(path.dirname(worktreePath));
  return {
    callerSessionId: input.callerSessionId,
    originalCwd: callerCwd,
    mainRepo,
    worktreePath,
    startCommit,
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
      '--detach',
      prepared.worktreePath,
      prepared.startCommit,
    ],
    prepared.mainRepo,
    { timeoutMs: ENTER_WORKTREE_MUTATION_TIMEOUT_MS },
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
  });
}

export const _internalIsError = isError;
