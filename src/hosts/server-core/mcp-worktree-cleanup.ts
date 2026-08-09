import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { parseWorkspaceDirectoryRef } from '@contracts/index';
import { runGitDefault } from '@main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps';
import type { AgentAdapter } from '@main/adapters/types';
import { getDb } from '@main/store/db';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import {
  assertWorktreeClean,
  assertWorktreeHeadIsReferenced,
  DirtyWorktreeError,
  UnreferencedWorktreeHeadError,
} from '@main/session/worktree-transition/git-safety';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';
import type { LifecycleState } from '@shared/types/session';

import {
  WORKTREE_CLEANUP_UNPROVED_MARKER,
} from '@main/session/worktree-transition/constants';
import {
  ServerCoreWorktreeError,
} from './mcp-worktree-port';
import type { ServerCoreWorktreePaths } from './mcp-worktree-paths';
import { serverCoreWorktreeReferenceFence } from './worktree-reference-fence';

const GIT_CHECK_TIMEOUT_MS = 30_000;
const GIT_REMOVE_TIMEOUT_MS = 10 * 60_000;

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function sameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export interface ServerCoreWorktreeCleanupOptions {
  readonly paths: ServerCoreWorktreePaths;
  readonly registry: { list(): AgentAdapter[] };
}

interface PersistedReferences {
  readonly blocking: string[];
  readonly closed: Array<{ id: string; cwd: string }>;
}

/** Cleanup fences use the Core registry and Core SQLite graph, never Electron globals. */
export class ServerCoreWorktreeCleanup {
  constructor(private readonly options: ServerCoreWorktreeCleanupOptions) {}

  async preflight(
    record: WorktreeTransitionRecord,
    input: { readonly worktreePath?: string; readonly discardChanges: boolean },
  ): Promise<{ exists: boolean }> {
    if (record.phase !== 'active') {
      throw new ServerCoreWorktreeError(
        '当前 worktree lease 尚未进入 active 状态',
        '请等待自动目录切换完成后再调用 exit_worktree。',
      );
    }
    if (input.worktreePath !== undefined) {
      const requested = parseWorkspaceDirectoryRef(input.worktreePath, 'worktreePath');
      if (requested !== this.options.paths.toRelative(record.worktreePath)) {
        throw new ServerCoreWorktreeError(
          'worktreePath 与当前会话持有的 lease 不一致',
          '请省略该字段，或传入 enter_worktree 返回的 Workspace 相对路径。',
        );
      }
    }
    if (!(await exists(record.worktreePath))) return { exists: false };
    await this.assertLeaseIdentity(record);
    await this.assertDurableHead(record.worktreePath);
    if (!input.discardChanges) await this.assertClean(record.worktreePath);
    return { exists: true };
  }

  async cleanup(record: WorktreeTransitionRecord): Promise<{ worktreeRemoved: boolean }> {
    const fence = this.acquireCleanupFence(record.worktreePath);
    try {
    await this.assertNoReferences(record);
    if (!(await exists(record.worktreePath))) return { worktreeRemoved: false };
    await this.assertLeaseIdentity(record);
    await this.assertDurableHead(record.worktreePath);
    if (!record.discardChanges) await this.assertClean(record.worktreePath);
    try {
      await runGitDefault(
        record.discardChanges
          ? ['worktree', 'remove', '--force', record.worktreePath]
          : ['worktree', 'remove', record.worktreePath],
        record.mainRepo,
        { timeoutMs: GIT_REMOVE_TIMEOUT_MS },
      );
    } catch {
      throw new ServerCoreWorktreeError(
        'Git worktree 清理失败',
        '会话已经恢复到原目录；worktree 与 Git 引用仍被保留，请处理后重试 exit_worktree。',
      );
    }
    return { worktreeRemoved: true };
    } finally {
      fence.release();
    }
  }

  async rollbackEnter(record: WorktreeTransitionRecord): Promise<void> {
    const fence = this.acquireCleanupFence(record.worktreePath);
    try {
    await this.assertNoReferences(record);
    if (!(await exists(record.worktreePath))) {
      if (record.lastError?.startsWith(`${WORKTREE_CLEANUP_UNPROVED_MARKER}:`)) {
        throw new ServerCoreWorktreeError(
          '未确认的 worktree 清理不能由路径缺失证明完成',
          'Core 已保留 lease；请检查主仓库 worktree 状态和移动后的目录，再进行恢复。',
        );
      }
      return;
    }
    await this.assertLeaseIdentity(record);
    await this.assertClean(record.worktreePath);
    await this.assertDurableHead(record.worktreePath);
    try {
      await runGitDefault(
        ['worktree', 'remove', record.worktreePath],
        record.mainRepo,
        { timeoutMs: GIT_REMOVE_TIMEOUT_MS },
      );
    } catch {
      throw new ServerCoreWorktreeError(
        '未确认的 worktree 无法安全回滚',
        'Core 已保留 lease 与目录；请检查仓库后重试恢复，不能覆盖或删除该目录。',
      );
    }
    } finally {
      fence.release();
    }
  }

  private acquireCleanupFence(worktreePath: string) {
    try {
      return serverCoreWorktreeReferenceFence.acquireCleanup(worktreePath);
    } catch {
      throw new ServerCoreWorktreeError(
        'worktree 正在被另一个会话引用',
        '请等待会话创建或 handoff 完成，然后重试 worktree 清理。',
      );
    }
  }

  private async assertLeaseIdentity(record: WorktreeTransitionRecord): Promise<void> {
    let worktree: string;
    let common: string;
    let mainRepo: string;
    try {
      worktree = await realpath(record.worktreePath);
      this.options.paths.toRelative(worktree);
      common = await runGitDefault(
        ['rev-parse', '--git-common-dir'],
        worktree,
        { timeoutMs: GIT_CHECK_TIMEOUT_MS },
      );
      const commonPath = path.isAbsolute(common) ? common : path.resolve(worktree, common);
      mainRepo = await realpath(path.dirname(await realpath(commonPath)));
    } catch {
      throw new ServerCoreWorktreeError(
        'worktree lease 身份校验失败',
        '目录、lease 与 Git 引用均已保留；请检查 Workspace 内仓库身份。',
      );
    }
    if (worktree !== record.worktreePath || mainRepo !== record.mainRepo) {
      throw new ServerCoreWorktreeError(
        'worktree lease 身份已经变化',
        'Core 将保持 fail-closed，不会删除当前目录。',
      );
    }
  }

  private async assertClean(worktreePath: string): Promise<void> {
    try {
      await assertWorktreeClean(
        (args, cwd) => runGitDefault(args, cwd, { timeoutMs: GIT_CHECK_TIMEOUT_MS }),
        worktreePath,
      );
    } catch (error) {
      if (error instanceof DirtyWorktreeError) {
        throw new ServerCoreWorktreeError(
          'worktree 仍有未保存的修改',
          '请先 commit、stash 或复制所需文件；只有用户明确授权永久删除时才传 discardChanges=true。',
        );
      }
      throw error;
    }
  }

  private async assertDurableHead(worktreePath: string): Promise<void> {
    try {
      await assertWorktreeHeadIsReferenced(
        (args, cwd) => runGitDefault(args, cwd, { timeoutMs: GIT_CHECK_TIMEOUT_MS }),
        worktreePath,
      );
    } catch (error) {
      if (error instanceof UnreferencedWorktreeHeadError) {
        throw new ServerCoreWorktreeError(
          'worktree HEAD 尚未被分支、远端跟踪分支或标签引用',
          '请先创建一个包含该 commit 的本地分支或标签；discardChanges 不会授权丢失 commit。',
        );
      }
      throw error;
    }
  }

  private persistedReferences(worktreePath: string): PersistedReferences {
    const blocking: string[] = [];
    const closed: Array<{ id: string; cwd: string }> = [];
    const rows = getDb().prepare(
      `SELECT id, cwd, lifecycle FROM sessions ORDER BY id`,
    ).all() as Array<{ id: string; cwd: string; lifecycle: LifecycleState }>;
    for (const row of rows) {
      if (!path.isAbsolute(row.cwd)) {
        blocking.push(row.id);
        continue;
      }
      if (!sameOrInside(path.resolve(row.cwd), worktreePath)) continue;
      if (row.lifecycle === 'closed') closed.push({ id: row.id, cwd: row.cwd });
      else blocking.push(row.id);
    }
    return { blocking, closed };
  }

  private async assertNoReferences(record: WorktreeTransitionRecord): Promise<void> {
    const worktreePath = path.resolve(record.worktreePath);
    const persisted = this.persistedReferences(worktreePath);
    const live: string[] = [];
    const sessionRows = getDb().prepare(`SELECT id FROM sessions ORDER BY id`).all() as {
      id: string;
    }[];
    for (const row of sessionRows) {
      for (const adapter of this.options.registry.list()) {
        const runtimeCwd = adapter.getRuntimeCwd?.(row.id) ?? null;
        if (runtimeCwd && (!path.isAbsolute(runtimeCwd) ||
            sameOrInside(path.resolve(runtimeCwd), worktreePath))) {
          live.push(`${adapter.id}:${row.id}`);
        }
      }
    }
    const leases = worktreeTransitionRepo.listRecoverable()
      .filter((candidate) => {
        if (candidate.sessionId === record.sessionId) return false;
        const candidatePaths = [candidate.originalCwd, candidate.targetCwd];
        if (candidatePaths.some((value) => !path.isAbsolute(value) ||
            sameOrInside(path.resolve(value), worktreePath))) return true;
        if (!path.isAbsolute(candidate.worktreePath)) return true;
        const candidateWorktree = path.resolve(candidate.worktreePath);
        return sameOrInside(candidateWorktree, worktreePath) ||
          sameOrInside(worktreePath, candidateWorktree);
      })
      .map((candidate) => `${candidate.sessionId}:${candidate.generation}`);
    const references = [...persisted.blocking, ...live, ...leases];
    if (references.length > 0) {
      throw new ServerCoreWorktreeError(
        `worktree 仍被 ${references.slice(0, 8).join(', ')} 引用`,
        '请先让相关会话离开该目录；Core 不会删除仍被引用的 worktree。',
      );
    }
    this.releaseClosedReferences(persisted.closed, record);
  }

  private releaseClosedReferences(
    references: PersistedReferences['closed'],
    record: WorktreeTransitionRecord,
  ): void {
    if (references.length === 0) return;
    const update = getDb().prepare(
      `UPDATE sessions SET cwd = ? WHERE id = ? AND cwd = ? AND lifecycle = 'closed'`,
    );
    getDb().transaction(() => {
      for (const reference of references) {
        if (update.run(record.originalCwd, reference.id, reference.cwd).changes !== 1) {
          throw new ServerCoreWorktreeError(
            '关闭会话的历史 cwd 在清理期间发生变化',
            'worktree 已保留；请重新检查引用后再试。',
          );
        }
      }
    })();
  }
}
