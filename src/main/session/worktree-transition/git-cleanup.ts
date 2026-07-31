import * as path from 'node:path';
import { adapterRegistry } from '@main/adapters/registry';
import {
  existsSyncDefault,
  realpathSyncDefault,
  runGitDefault,
} from '@main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps';
import { getDb } from '@main/store/db';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import type { WorktreeTransitionRecord } from './types';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);
const WORKTREE_GIT_CHECK_TIMEOUT_MS = 30_000;
const WORKTREE_REMOVE_TIMEOUT_MS = 10 * 60_000;

export interface WorktreeExitPreflightResult {
  exists: boolean;
  workBranch: string | null;
}

export interface WorktreeCleanupResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  branchError: string | null;
}

function stripTrailingSlash(value: string): string {
  const stripped = value.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function normalizedPath(value: string): string {
  try {
    return stripTrailingSlash(realpathSyncDefault(value));
  } catch {
    return stripTrailingSlash(path.resolve(value));
  }
}

function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = WORKTREE_GIT_CHECK_TIMEOUT_MS,
): Promise<string> {
  return runGitDefault(args, cwd, { timeoutMs });
}

export function isSameOrInsideWorktreePath(
  candidate: string,
  root: string,
): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function assertOwnedPath(
  record: WorktreeTransitionRecord,
  override?: string,
): void {
  if (!override) return;
  if (
    normalizedPath(override) !==
    normalizedPath(record.worktreePath)
  ) {
    throw new Error(
      `args.worktreePath (${override}) does not match the structured worktree lease (${record.worktreePath}).`,
    );
  }
}

async function readWorktreeMainRepo(worktreePath: string): Promise<string> {
  const common = await runGit(
    ['rev-parse', '--git-common-dir'],
    worktreePath,
  );
  const absolute = path.isAbsolute(common)
    ? common
    : path.resolve(worktreePath, common);
  return path.dirname(absolute);
}

async function assertClean(record: WorktreeTransitionRecord): Promise<void> {
  if (record.discardChanges) return;
  const status = await runGit(
    ['status', '--porcelain'],
    record.worktreePath,
  );
  if (!status.trim()) return;
  const lines = status.split('\n');
  throw new Error(
    `worktree has uncommitted changes: ${lines.slice(0, 3).join(' / ')}${
      lines.length > 3 ? ' ...' : ''
    }`,
  );
}

export async function preflightStructuredWorktreeExit(
  record: WorktreeTransitionRecord,
  input: {
    worktreePathOverride?: string;
    discardChanges: boolean;
  },
): Promise<WorktreeExitPreflightResult> {
  if (record.phase !== 'active') {
    throw new Error(
      `Worktree transition ${record.sessionId}:${record.generation} is ${record.phase}; exit requires active.`,
    );
  }
  assertOwnedPath(record, input.worktreePathOverride);
  if (!existsSyncDefault(record.worktreePath)) {
    return { exists: false, workBranch: record.workBranch || null };
  }
  const actualMainRepo = await readWorktreeMainRepo(record.worktreePath);
  if (
    normalizedPath(actualMainRepo) !==
    normalizedPath(record.mainRepo)
  ) {
    throw new Error(
      `worktree git common dir resolves to ${actualMainRepo}, not leased main repo ${record.mainRepo}.`,
    );
  }
  const branch =
    (
      await runGit(
        ['branch', '--show-current'],
        record.worktreePath,
      )
    ).trim() || null;
  const expectedBranch = record.workBranch || null;
  if (branch !== expectedBranch) {
    throw new Error(
      `worktree branch changed from leased ${expectedBranch ?? 'detached HEAD'} to ${branch ?? 'detached HEAD'}.`,
    );
  }
  if (!input.discardChanges) {
    await assertClean({ ...record, discardChanges: false });
  }
  return { exists: true, workBranch: branch };
}

async function persistedCwdReferences(
  normalizedWorktreePath: string,
): Promise<string[]> {
  const references: string[] = [];
  const rows = getDb()
    .prepare(`SELECT id, cwd FROM sessions ORDER BY id`)
    .all() as Array<{ id: string; cwd: string }>;
  for (const row of rows) {
    if (
      isSameOrInsideWorktreePath(
        normalizedPath(row.cwd),
        normalizedWorktreePath,
      )
    ) {
      references.push(row.id);
    }
  }
  return references;
}

async function liveCwdReferences(
  normalizedWorktreePath: string,
  excludingSessionId: string,
): Promise<string[]> {
  const references: string[] = [];
  const rows = getDb()
    .prepare(`SELECT id FROM sessions ORDER BY id`)
    .all() as { id: string }[];
  for (const row of rows) {
    if (row.id === excludingSessionId) continue;
    for (const adapter of adapterRegistry.list()) {
      const runtimeCwd = adapter.getRuntimeCwd?.(row.id) ?? null;
      if (
        runtimeCwd &&
        isSameOrInsideWorktreePath(
          normalizedPath(runtimeCwd),
          normalizedWorktreePath,
        )
      ) {
        references.push(`${adapter.id}:${row.id}`);
      }
    }
  }
  return references;
}

async function assertNoWorktreeReferences(
  record: WorktreeTransitionRecord,
): Promise<void> {
  const target = normalizedPath(record.worktreePath);
  const persisted = await persistedCwdReferences(target);
  const live = await liveCwdReferences(target, record.sessionId);
  const leases: string[] = [];
  for (const candidate of worktreeTransitionRepo.listRecoverable()) {
    if (
      candidate.sessionId !== record.sessionId &&
      isSameOrInsideWorktreePath(
        normalizedPath(candidate.worktreePath),
        target,
      )
    ) {
      leases.push(
        `${candidate.sessionId}:${candidate.generation}:${candidate.phase}`,
      );
    }
  }
  const all = [...persisted, ...live, ...leases];
  if (all.length > 0) {
    throw new Error(
      `worktree is still referenced by ${all.join(', ')}; cleanup is fail-closed.`,
    );
  }
  for (const adapter of adapterRegistry.list()) {
    const runtimeCwd = adapter.getRuntimeCwd?.(record.sessionId) ?? null;
    if (
      runtimeCwd &&
      isSameOrInsideWorktreePath(normalizedPath(runtimeCwd), target)
    ) {
      throw new Error(
        `caller runtime ${adapter.id}:${record.sessionId} still points to the worktree.`,
      );
    }
  }
}

/** Restore-first cleanup. This performs the mandatory second dirty check immediately before rm. */
export async function cleanupStructuredWorktree(
  record: WorktreeTransitionRecord,
): Promise<WorktreeCleanupResult> {
  await assertNoWorktreeReferences(record);
  if (!existsSyncDefault(record.worktreePath)) {
    return {
      worktreeRemoved: false,
      branchDeleted: false,
      branchError: null,
    };
  }
  await assertClean(record);
  await runGit(
    record.discardChanges
      ? ['worktree', 'remove', '--force', record.worktreePath]
      : ['worktree', 'remove', record.worktreePath],
    record.mainRepo,
    WORKTREE_REMOVE_TIMEOUT_MS,
  );
  if (
    !record.deleteBranch ||
    !record.workBranch ||
    PROTECTED_BRANCHES.has(record.workBranch)
  ) {
    return {
      worktreeRemoved: true,
      branchDeleted: false,
      branchError: null,
    };
  }
  try {
    await runGit(
      [
        'branch',
        record.discardChanges ? '-D' : '-d',
        record.workBranch,
      ],
      record.mainRepo,
    );
    return {
      worktreeRemoved: true,
      branchDeleted: true,
      branchError: null,
    };
  } catch (error) {
    return {
      worktreeRemoved: true,
      branchDeleted: false,
      branchError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Startup recovery for an enter request whose provider result was never observed. It never forces
 * removal and deletes the generated branch only when it still points at the frozen base commit.
 */
export async function rollbackUnacknowledgedEnter(
  record: WorktreeTransitionRecord,
): Promise<WorktreeCleanupResult> {
  await assertNoWorktreeReferences(record);
  let worktreeRemoved = false;
  if (existsSyncDefault(record.worktreePath)) {
    await assertClean({ ...record, discardChanges: false });
    await runGit(
      ['worktree', 'remove', record.worktreePath],
      record.mainRepo,
      WORKTREE_REMOVE_TIMEOUT_MS,
    );
    worktreeRemoved = true;
  }

  let branchTip: string | null = null;
  try {
    branchTip = (
      await runGit(
        [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${record.workBranch}^{commit}`,
        ],
        record.mainRepo,
      )
    ).trim();
  } catch {
    // The branch may not have been created before the app stopped.
  }
  if (!branchTip) {
    return {
      worktreeRemoved,
      branchDeleted: false,
      branchError: null,
    };
  }
  if (branchTip !== record.baseCommit) {
    return {
      worktreeRemoved,
      branchDeleted: false,
      branchError:
        `generated branch ${record.workBranch} moved from base commit; retained for recovery`,
    };
  }
  try {
    await runGit(
      ['branch', '-d', record.workBranch],
      record.mainRepo,
    );
    return {
      worktreeRemoved,
      branchDeleted: true,
      branchError: null,
    };
  } catch (error) {
    return {
      worktreeRemoved,
      branchDeleted: false,
      branchError: error instanceof Error ? error.message : String(error),
    };
  }
}
