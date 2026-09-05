/** Delete tasks and clean surviving dependency references in one transaction. */
import type { Database } from 'better-sqlite3';
import { getById } from './_deps';
import { cleanupBlocksReferences } from '../task-dependency-cleanup';
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
