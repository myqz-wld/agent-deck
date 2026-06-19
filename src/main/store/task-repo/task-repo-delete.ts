/**
 * Task Manager 持久层 delete 子模块（plan task-team-id-restore-20260525 v024）。
 *
 * 提供 delete method + 共享 cleanupBlocksReferences helper export。
 *
 * - **delete**：cascade BFS 按 blocks 链路向下扫,predicate 可挡跨 team cascade（tool 层
 *   写权限校验）;单 db.transaction() 内原子化两步:(1) chunked DELETE FROM tasks WHERE
 *   id IN (?)（CHUNK=500 防 SQLite IN 999 上限）(2) 调 cleanupBlocksReferences 清理
 *   survivors 的 blocks/blocked_by 引用
 * - **cleanupBlocksReferences**：export 让 handoff 子模块（applyHandOffSkipPolicy）共享
 *   同款 cleanup 逻辑 — handoff → delete 单向依赖（同 Step 4.3/4.4 的 index → recoverer
 *   单向 pattern）。**必须在 db.transaction() 内调**（不自开 tx,由 caller 保证原子性）
 *
 * F6 修法（deep-review Round 1 reviewer-codex LOW-1）:cleanup 内裸 JSON.parse 包 try/catch,
 * 避免脏 JSON survivor 让 cleanup 阶段抛错并整 tx 回滚。
 */
import type { Database } from 'better-sqlite3';
import { type Row, getById, safeJsonArray } from './_deps';
import type { TaskRecord } from '@shared/types';

export interface TaskDeleteOps {
  delete(
    id: string,
    opts?: {
      cascade?: boolean;
      predicate?: (
        id: string,
        child: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,
      ) => boolean;
    },
  ): string[];
}

/**
 * 提取 cleanup blocks/blocked_by 引用为 helper,让 del() 与 applyHandOffSkipPolicy()
 * 共享同款 cleanup 逻辑（v024 plan §D4 + Step B1）。
 *
 * **必须在 db.transaction() 内调**（不自开 tx,由 caller 保证原子性）。
 * SELECT survivors → 过滤 blocks/blocked_by 引用 deletedIds 的项 → UPDATE 写回。
 *
 * **F6 修法**(deep-review Round 1 reviewer-codex LOW-1):裸 JSON.parse 包 try/catch,
 * 避免脏 JSON survivor 让 cleanup 阶段抛错并整 tx 回滚。
 */
export function cleanupBlocksReferences(db: Database, deletedIds: Set<string>): void {
  const survivors = db.prepare(`SELECT id, blocks, blocked_by FROM tasks`).all() as Array<
    Pick<Row, 'id' | 'blocks' | 'blocked_by'>
  >;
  const cleanStmt = db.prepare(`UPDATE tasks SET blocks = ?, blocked_by = ? WHERE id = ?`);
  for (const s of survivors) {
    const blocks = safeJsonArray(s.blocks, 'blocks', s.id).filter((x) => !deletedIds.has(x));
    const blockedBy = safeJsonArray(s.blocked_by, 'blocked_by', s.id).filter(
      (x) => !deletedIds.has(x),
    );
    // 仅当真发生变化才 UPDATE,避免 N+1 写放大。
    let origBlocks: unknown;
    let origBlockedBy: unknown;
    try {
      origBlocks = JSON.parse(s.blocks);
    } catch {
      origBlocks = null; // 标 invalid → changedBlocks=true 写回 clean
    }
    try {
      origBlockedBy = JSON.parse(s.blocked_by);
    } catch {
      origBlockedBy = null;
    }
    const changedBlocks =
      !Array.isArray(origBlocks) || origBlocks.length !== blocks.length;
    const changedBlockedBy =
      !Array.isArray(origBlockedBy) || origBlockedBy.length !== blockedBy.length;
    if (changedBlocks || changedBlockedBy) {
      cleanStmt.run(JSON.stringify(blocks), JSON.stringify(blockedBy), s.id);
    }
  }
}

export function createDelete(db: Database): TaskDeleteOps {
  function del(
    id: string,
    opts: {
      cascade?: boolean;
      predicate?: (
        id: string,
        child: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,
      ) => boolean;
    } = {},
  ): string[] {
    const target = getById(db, id);
    if (!target) return [];

    const toDelete = new Set<string>([id]);
    if (opts.cascade) {
      const queue = [...target.blocks];
      while (queue.length) {
        const next = queue.shift()!;
        if (toDelete.has(next)) continue;
        const child = getById(db, next);
        if (!child) continue;
        // v024 plan §不变量 12 + Step B1:predicate 签名传 child 完整 task（至少
        // ownerSessionId + teamId）让 D3 按 task.team_id 判权限边界。
        if (
          opts.predicate &&
          !opts.predicate(child.id, { ownerSessionId: child.ownerSessionId, teamId: child.teamId })
        ) {
          continue;
        }
        toDelete.add(next);
        queue.push(...child.blocks);
      }
    }

    const tx = db.transaction(() => {
      // 1. 删除目标 + cascade 下游 — 详 v023 F2/F-R2-B 原子性契约（沿用）
      const toDeleteArr = Array.from(toDelete);
      const CHUNK = 500;
      for (let i = 0; i < toDeleteArr.length; i += CHUNK) {
        const chunk = toDeleteArr.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...chunk);
      }

      // 2. 清理剩余 task 的 blocks / blocked_by 数组里指向已删 id 的引用 — 详 v023
      //    F6 修法（裸 JSON.parse 包 try/catch）沿用,加 cleanup BFS 模式。
      cleanupBlocksReferences(db, toDelete);
    });
    tx();
    // 返回所有被删的 id（含 root + cascade 下游）,让 tools.ts task_delete 按 id
    // 逐个 emit task-changed,TasksPanel 不会因为只 emit root 一次而 N-1 个
    // 下游 task UI stale。
    return Array.from(toDelete);
  }

  return { delete: del };
}
