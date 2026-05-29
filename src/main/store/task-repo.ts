/**
 * Task Manager 持久层（plan task-team-id-restore-20260525 v024 重设计 — v023 follow-up）。
 *
 * 为「Claude Agent SDK 没有原生任务管理工具」补一套结构化 task store，让 5 个
 * in-process MCP tools（task_create / task_list / task_get / task_update /
 * task_delete）能跨 SDK Agent 协作。设计骨架来自 sdk-task-manager-spec.md，
 * 但持久层实现按 agent-deck 既有约定改成 SQLite + better-sqlite3：
 *
 * - 同步 SQL（与 summary-repo / event-repo / session-repo 风格一致）
 * - WAL + 单进程，自身处理并发，无需 Promise queue / proper-lockfile
 * - 通过 `createTaskRepo(db)` 工厂注入 db，让测试用 in-memory 数据库独立跑
 * - 默认导出 `taskRepo` 懒拿 getDb()，运行时调用方无感
 *
 * **v024 Phase 4 Step 4.5 拆分（plan deep-project-review-comprehensive-20260528）**:
 * 本文件改为 facade,实质实现拆到 `task-repo/` 子目录 4 子模块:
 *   - `task-repo/_deps.ts` — types/interfaces SSOT + 公共 helpers（safeJsonArray /
 *     rowToRecord / toColumnValue / getById）+ UPDATABLE_KEYS / COL_MAP 常量
 *   - `task-repo/task-repo-crud.ts` — createCrud(db) → { create, get, update }
 *   - `task-repo/task-repo-list.ts` — createList(db) → { list }（filter/pagination）
 *   - `task-repo/task-repo-delete.ts` — createDelete(db) → { delete } + export
 *     cleanupBlocksReferences helper（让 handoff 子模块共享）
 *   - `task-repo/task-repo-handoff.ts` — createHandoff(db) → { reassignOwner,
 *     applyHandOffSkipPolicy, findOwnedDistinctTeamIds }（hand_off_session 三方法）
 *
 * 子模块 import 关系:`handoff → delete`（applyHandOffSkipPolicy 复用 cleanupBlocksReferences）
 * 单向依赖,与 Step 4.3/4.4 sdk-bridge index → recoverer 单向 pattern 同款。
 *
 * **测试 import path 不动**:本 facade 文件 byte-identical re-export 全部对外 type/interface +
 * createTaskRepo + taskRepo singleton,所有测试 import 零改动。
 *
 * v024 重设计（plan §D1-D8）— v023 follow-up 加回 team_id NULLABLE 字段:
 * - tasks 表 owner_session_id NOT NULL（v023 沿用）+ team_id TEXT NULL（v024 新增）
 * - team_id != null = team-bound task,可见性 / 写权限按 team 严格隔离（D3）
 * - team_id IS NULL = personal task（first-class 用例,无 team caller 也能用 task — RFC R1.Q1）
 * - team scope 从 derived 改回 stored（消灭 v023 lead 多 team task 串流根因 — plan §起源）
 * - 不复活 global task 累积:owner_session_id NOT NULL 兜底 GC 不变,team 硬删时
 *   tasks.team_id ON DELETE SET NULL 退化为 personal task,owner archive 后 CASCADE 删
 * - hand_off team_task_policy 三态（D4）:clear-team（默认） / preserve-team / skip
 *   - clear-team: reassignOwner({policy:'clear-team'}) UPDATE owner + team_id=NULL
 *   - preserve-team: reassignOwner({policy:'preserve-team'}) UPDATE owner 不动 team_id
 *   - skip: applyHandOffSkipPolicy 单 transaction 4 步原子化(SELECT 团 task → DELETE → cleanup → reassign personal)
 *
 * 已知限制（与 spec §5 / §7 一致）：
 * - 不做 blocks / blockedBy 循环依赖检测
 * - subject / description 长度等业务校验放在 tool 层（Zod schema），repo 层只做
 *   存在性 + 数据完整性约束（subject 非空），保证 repo 单元测试不依赖 zod
 */
import type { Database } from 'better-sqlite3';
import { getDb } from './db';
import {
  type ApplyHandOffSkipResult,
  type ReassignOwnerPolicy,
  type TaskCreateInput,
  type TaskListOptions,
  type TaskListTeamIdFilter,
  type TaskRepo,
} from './task-repo/_deps';
import { createCrud } from './task-repo/task-repo-crud';
import { createList } from './task-repo/task-repo-list';
import { createDelete } from './task-repo/task-repo-delete';
import { createHandoff } from './task-repo/task-repo-handoff';

// Re-export public types(byte-identical 让外部 import path 不动)
export type {
  ApplyHandOffSkipResult,
  ReassignOwnerPolicy,
  TaskCreateInput,
  TaskListOptions,
  TaskListTeamIdFilter,
  TaskRepo,
};

/**
 * 主 factory:把 4 子模块组装成对外 TaskRepo 接口。
 *
 * 子模块共享 db: Database,各 createX(db) 返回独立 ops 对象,facade 这里 spread
 * 合并 + 把 createDelete 的 `delete` method 显式 wire 进 TaskRepo（避免与 JS 关键字冲突）。
 */
export function createTaskRepo(db: Database): TaskRepo {
  const crud = createCrud(db);
  const list = createList(db);
  const del = createDelete(db);
  const handoff = createHandoff(db);
  return {
    create: crud.create,
    get: crud.get,
    update: crud.update,
    list: list.list,
    delete: del.delete,
    reassignOwner: handoff.reassignOwner,
    applyHandOffSkipPolicy: handoff.applyHandOffSkipPolicy,
    findOwnedDistinctTeamIds: handoff.findOwnedDistinctTeamIds,
  };
}

/**
 * 默认 repo：每次方法调用懒拿 getDb()。模块加载时 getDb() 还没 init，
 * 所以不能 eager 构造；缓存到模块 closure，避免每次方法调用重建。
 */
let _defaultRepo: TaskRepo | null = null;
function defaultRepo(): TaskRepo {
  if (!_defaultRepo) _defaultRepo = createTaskRepo(getDb());
  return _defaultRepo;
}

export const taskRepo: TaskRepo = {
  create: (input) => defaultRepo().create(input),
  get: (id) => defaultRepo().get(id),
  list: (opts) => defaultRepo().list(opts),
  update: (id, patch) => defaultRepo().update(id, patch),
  delete: (id, opts) => defaultRepo().delete(id, opts),
  reassignOwner: (oldSid, newSid, opts) => defaultRepo().reassignOwner(oldSid, newSid, opts),
  applyHandOffSkipPolicy: (callerSid, newSid) =>
    defaultRepo().applyHandOffSkipPolicy(callerSid, newSid),
  findOwnedDistinctTeamIds: (callerSid) => defaultRepo().findOwnedDistinctTeamIds(callerSid),
};
