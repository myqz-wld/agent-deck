/**
 * Task Manager 持久层 hand_off 子模块（plan task-team-id-restore-20260525 v024）。
 *
 * 提供 hand_off_session 三方法支撑:
 * - **reassignOwner**：'clear-team' / 'preserve-team' 两态 — 单 SQL UPDATE 原子改
 *   ownerSessionId（clear-team 同时清 team_id=NULL）。不刷 updated_at（F5 修法,
 *   list 排序稳定）
 * - **applyHandOffSkipPolicy**：'skip' policy 专用 helper — 单 db.transaction() 内
 *   原子化 4 步:(1) SELECT team task id snapshot (2) chunked DELETE (3) cleanup
 *   blocks/blocked_by 引用（共享 task-repo-delete 子模块的 cleanupBlocksReferences
 *   — handoff → delete 单向依赖）(4) reassign 剩余 personal task
 * - **findOwnedDistinctTeamIds**：preserve-team safety 算法 helper — 单 SQL DISTINCT
 *   拿 caller 拥有 task 的 distinct non-null team_id（用于 handler 端差集计算
 *   policyWarning='preserve-team-unadopted-teams' + unadoptedTeamIds 暴露根因）
 *
 * v024 plan §D4 + Step B1 / D2 / §不变量 11/12 见 _deps.ts TaskRepo interface jsdoc 详述。
 */
import type { Database } from 'better-sqlite3';
import {
  type ApplyHandOffSkipResult,
  type ReassignOwnerPolicy,
  type Row,
} from './_deps';
import { cleanupBlocksReferences } from './task-repo-delete';

export interface TaskHandoffOps {
  reassignOwner(
    oldSessionId: string,
    newSessionId: string,
    opts: { policy: ReassignOwnerPolicy },
  ): number;
  applyHandOffSkipPolicy(callerSid: string, newSid: string): ApplyHandOffSkipResult;
  findOwnedDistinctTeamIds(callerSid: string): string[];
}

export function createHandoff(db: Database): TaskHandoffOps {
  function reassignOwner(
    oldSessionId: string,
    newSessionId: string,
    opts: { policy: ReassignOwnerPolicy },
  ): number {
    // v023/v024 plan §D3 + D4:hand_off_session tool 在 spawn 新 session 之后、
    // archive caller 之前调,原子把 caller 拥有的所有 task 转给新 session。
    //
    // FK 约束:newSessionId 必须在 sessions 表存在(不存在 → SQLite throw FK 错)。
    // 调用方(hand_off-session handler)保证新 session 已 spawn 落 DB 才调本接口。
    //
    // 单 SQL UPDATE,N 条 task 一次完成。FK 不在被改字段上(owner_session_id
    // 改值,新值合法即可),SQLite 不会触发 CASCADE 副作用。
    //
    // **F5 修法**(deep-review Round 1 reviewer-claude MED-c3):**不刷 updated_at**。
    // reassign 是 owner 换不是 task content 改,保留原 updated_at 让 list 排序稳定。
    //
    // v024 plan §D4 policy 两态:
    // - 'clear-team':SET owner + team_id=NULL（过继 + 清 team 标签变 personal）
    // - 'preserve-team':SET owner 不动 team_id（caller 自负保证 adopt teammates）
    //
    // 'skip' 不在本接口走（plan §不变量 12）— skip 走 applyHandOffSkipPolicy 单 tx 4 步。
    let sql: string;
    if (opts.policy === 'clear-team') {
      sql = `UPDATE tasks SET owner_session_id = ?, team_id = NULL WHERE owner_session_id = ?`;
    } else {
      // 'preserve-team'
      sql = `UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?`;
    }
    const info = db.prepare(sql).run(newSessionId, oldSessionId);
    return Number(info.changes ?? 0);
  }

  function applyHandOffSkipPolicy(
    callerSid: string,
    newSid: string,
  ): ApplyHandOffSkipResult {
    // v024 plan §D4 + Step B1（Round 3 MED-1 + Round 4 MED-2/3 + Round 6 MED-1 收口）:
    // 'skip' policy 真删 helper — 单 db.transaction() 4 步原子化（plan §不变量 4）。
    //
    // 与 del() 不同的是,本 helper 是 hand_off 专用 batch:删 caller 拥有的全部 team task
    // + 一次性 cleanup blocks/blocked_by + reassign 剩余 personal task,原子化避免中间状态。
    let deletedTeamTaskIds: string[] = [];
    let reassignedPersonalCount = 0;
    const tx = db.transaction(() => {
      // Step 1: SELECT caller team task ids snapshot（handler 后续 safeEmit 用）
      const teamTaskRows = db
        .prepare(
          `SELECT id FROM tasks WHERE owner_session_id = ? AND team_id IS NOT NULL`,
        )
        .all(callerSid) as Array<Pick<Row, 'id'>>;
      deletedTeamTaskIds = teamTaskRows.map((r) => r.id);

      // Step 2: chunked DELETE FROM tasks WHERE id IN (?)（CHUNK=500 防 IN 999 上限,
      // 与 del() cascade DELETE 同款）。一次性 batch 删除全部 caller team task。
      if (deletedTeamTaskIds.length > 0) {
        const CHUNK = 500;
        for (let i = 0; i < deletedTeamTaskIds.length; i += CHUNK) {
          const chunk = deletedTeamTaskIds.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => '?').join(',');
          db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...chunk);
        }
      }

      // Step 3: blocks/blocked_by 引用 cleanup（与 del() cleanupBlocksReferences 同款,
      // 同 transaction 内 SELECT survivors → 过滤 → UPDATE 写回）。
      // deletedTeamTaskIds 全 batch 一次性 cleanup,不 BFS 逐个。
      if (deletedTeamTaskIds.length > 0) {
        cleanupBlocksReferences(db, new Set(deletedTeamTaskIds));
      }

      // Step 4: UPDATE tasks SET owner_session_id=newSid WHERE owner_session_id=callerSid
      //         AND team_id IS NULL → reassign 剩余 personal task（personal 仍正常过继,
      //         只是 team task 已被 step 2 删走,这里只过继剩余 personal）。
      const personalInfo = db
        .prepare(
          `UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ? AND team_id IS NULL`,
        )
        .run(newSid, callerSid);
      reassignedPersonalCount = Number(personalInfo.changes ?? 0);
    });
    // tx() 抛错时整 transaction ROLLBACK 保留原集（plan §Step B2 case B 测试锁定）。
    // 任一 step 抛错 → ROLLBACK → deletedTeamTaskIds / reassignedPersonalCount 仍是
    // 闭包内中间值,但调用方应在 try/catch 内 catch 这个 throw（详 hand-off-session.ts
    // Step D2 单一伪代码块 outer try/catch fallback）。
    tx();
    return { deletedTeamTaskIds, reassignedPersonalCount };
  }

  function findOwnedDistinctTeamIds(callerSid: string): string[] {
    // v024 plan §Step D2 preserve-team safety 算法 helper（Round 4 HIGH-1 修法支撑）:
    // 单 SQL DISTINCT 拿 caller 拥有 task 的 distinct non-null team_id 列表（personal
    // task team_id IS NULL 被排除）。hand_off preserve-team 路径用此与 newSid handoff
    // 后 active teams 比对差集 → policyWarning='preserve-team-unadopted-teams' +
    // unadoptedTeamIds 字段暴露根因。
    const rows = db
      .prepare(
        `SELECT DISTINCT team_id FROM tasks WHERE owner_session_id = ? AND team_id IS NOT NULL`,
      )
      .all(callerSid) as Array<{ team_id: string }>;
    return rows.map((r) => r.team_id);
  }

  return { reassignOwner, applyHandOffSkipPolicy, findOwnedDistinctTeamIds };
}
