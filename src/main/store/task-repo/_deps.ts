/**
 * Task Manager 持久层共享 types / helpers SSOT（plan task-team-id-restore-20260525 v024）。
 *
 * 6 子模块共享:_deps.ts 持有 Row 内部 schema interface + 6 个对外 types/interfaces
 * + UPDATABLE_KEYS / COL_MAP 常量 + safeJsonArray / rowToRecord / toColumnValue 三 helper
 * + getById free function（让 update / delete 跨子模块共享同款 SELECT 实现,避免重复 SQL）。
 *
 * **不放业务 SQL**：业务 SQL 分流到 task-repo-crud / task-repo-list / task-repo-delete /
 * task-repo-handoff 4 个子模块,本文件仅做 types + 公共 helpers + 1 个 getById 跨模块入口。
 *
 * v024 重设计（plan §D1-D8）— v023 follow-up 加回 team_id NULLABLE 字段:
 * - tasks 表 owner_session_id NOT NULL（v023 沿用）+ team_id TEXT NULL（v024 新增）
 * - team_id != null = team-bound task,可见性 / 写权限按 team 严格隔离（D3）
 * - team_id IS NULL = personal task（first-class 用例,无 team caller 也能用 task — RFC R1.Q1）
 * - team scope 从 derived 改回 stored（消灭 v023 lead 多 team task 串流根因 — plan §起源）
 * - 不复活 global task 累积:owner_session_id NOT NULL 兜底 GC 不变,team 硬删时
 *   tasks.team_id ON DELETE SET NULL 退化为 personal task,owner archive 后 CASCADE 删
 */
import type { Database } from 'better-sqlite3';
import type { TaskRecord, TaskStatus } from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('task-repo-deps');

/** SQLite row 内部 schema（snake_case 列名）。仅子模块内部使用,不对外 export。 */
export interface Row {
  id: string;
  owner_session_id: string;
  /** v024:team-bound task = uuid;personal task = null（plan §D1） */
  team_id: string | null;
  subject: string;
  description: string | null;
  status: string;
  active_form: string | null;
  priority: number;
  blocks: string;
  blocked_by: string;
  labels: string;
  created_at: string;
  updated_at: string;
}

/**
 * 把 JSON 数组字段从 string 解码回 string[]，损坏时退化为空数组并 warn——
 * 不抛错，避免一条脏数据让整个 list 接口挂掉（store-repo 守门）。
 */
export function safeJsonArray(raw: string, field: string, taskId: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
    logger.warn(`[task-repo] task ${taskId} 字段 ${field} 不是 string[]，退化空数组：${raw}`);
    return [];
  } catch (e) {
    logger.warn(`[task-repo] task ${taskId} 字段 ${field} JSON 解析失败，退化空数组：${e}`);
    return [];
  }
}

/** Row → TaskRecord 转换:snake_case 列名 → camelCase + JSON 数组解码。 */
export function rowToRecord(r: Row): TaskRecord {
  return {
    id: r.id,
    ownerSessionId: r.owner_session_id,
    teamId: r.team_id,
    subject: r.subject,
    description: r.description,
    status: r.status as TaskStatus,
    activeForm: r.active_form,
    priority: r.priority,
    blocks: safeJsonArray(r.blocks, 'blocks', r.id),
    blockedBy: safeJsonArray(r.blocked_by, 'blocked_by', r.id),
    labels: safeJsonArray(r.labels, 'labels', r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 跨子模块共享的 task 单条查询(原 createTaskRepo 内 `get(id)` 同款实现)。
 *
 * **用途**:task-repo-crud(update 前置 SELECT) + task-repo-delete(del cascade BFS 拿 child)
 * 共享同款实现,避免重复 SQL。task-repo-crud 也对外 export `get` method 走本 helper。
 */
export function getById(db: Database, id: string): TaskRecord | null {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export interface TaskCreateInput {
  /** v023：必填，绑 caller session（tool 层从 caller_session_id 闭包注入）。 */
  ownerSessionId: string;
  /**
   * v024（plan §D1）:可选 team 归属。
   * - 不传 / undefined / null = personal task（仅 owner 可见可写）
   * - 传 string（team uuid） = team-bound task，caller 必须在该 team 是 active member（D3 由 tool 层校验）
   */
  teamId?: string | null;
  subject: string;
  description?: string | null;
  status?: TaskStatus;
  activeForm?: string | null;
  priority?: number;
  blocks?: string[];
  blockedBy?: string[];
  labels?: string[];
}

/**
 * v024 plan §D5：list team_id filter 三态字面量类型。
 * - `undefined` = 不过滤（caller 视角 visible scope 由 tool 层 ownerSessionIds 控）
 * - `string` (team uuid) = 仅返该 team 绑定 task（team_id == X）
 * - `'null-personal'` 字面量 = 仅返 personal task（team_id IS NULL）
 *
 * Frozen by Round 1 LOW-1（plan §已知踩坑 4）— 用 zod literal `z.union([z.string().uuid(),
 * z.literal('null-personal')])`,literal 比 nullable 更显式 + caller call site 一眼看出语义。
 */
export type TaskListTeamIdFilter = string | 'null-personal' | undefined;

export interface TaskListOptions {
  /** 仅返回该状态。不传 = 不过滤 */
  status?: TaskStatus;
  /** subject 模糊匹配（大小写不敏感 contains）。不传 = 不过滤 */
  subjectKeyword?: string;
  /**
   * v023：owner session id IN 过滤。
   * - 不传 / undefined = 全部 task（管理员级别，慎用）
   * - 传 string[] = 仅返回 owner 在数组里的 task（含空数组 = 0 行）
   *
   * v024:tool 层 task_list 主路径走 visibleScope（一次 SQL OR 模式拿 caller 可见全部）
   * 或 teamIdFilter（单 team / personal-only）;ownerSessionIds 仍保留供「caller 自己 personal task」
   * 路径 + visibleScope 内部使用。
   */
  ownerSessionIds?: string[];
  /**
   * v024 plan §D5:team_id 三态 filter（详 TaskListTeamIdFilter type）。
   * - 不传 / undefined = 不过滤 team_id
   * - string (team uuid) = 仅返 team_id == X 的 task
   * - 'null-personal' = 仅返 team_id IS NULL 的 task（personal）
   */
  teamIdFilter?: TaskListTeamIdFilter;
  /**
   * v024 plan §D5 + Step C5:caller 视角 visible scope OR 模式（替代 v023 ownerSessionIds 主路径）。
   *
   * 传时走单 SQL OR query:`(team_id IN teamIds) OR (team_id IS NULL AND owner_session_id == callerSid)`,
   * 拿 caller 可见 team-bound task + 自己 personal task 一次完成。
   *
   * **优先级**:visibleScope 与 ownerSessionIds / teamIdFilter 互斥（visibleScope 传时其他两个忽略,
   * 由 task-list handler 三态分流时显式只传一个）。
   *
   * 失败兜底:visibleScope.teamIds === [] 时 OR 退化为 `team_id IS NULL AND owner_session_id = ?`,
   * 仅返 caller 自己 personal task。
   */
  visibleScope?: { teamIds: string[]; callerSid: string };
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
}

export interface TaskRepo {
  create(input: TaskCreateInput): TaskRecord;
  get(id: string): TaskRecord | null;
  list(opts?: TaskListOptions): TaskRecord[];
  /**
   * Apply a partial content patch. Undefined fields are ignored; nullable fields
   * accept null. Ownership changes only through reassignOwner, never this patch.
   */
  update(id: string, patch: Partial<TaskCreateInput>): TaskRecord | null;
  /**
   * 删除一条 task，cascade=true 时按 blocks 链路 BFS 级联下游。
   *
   * v024 plan §不变量 12 + Step B1:predicate 签名同步改造（HIGH-2 修法）。
   *
   * @param predicate 可选 cascade 路径过滤器：cascade BFS 入队前调
   *                  predicate(childId, child)，返回 false 则该 child 及其下游
   *                  都不进 toDelete 集合。tool 层用此挡跨 team cascade 删除
   *                  （写权限校验,按 task.team_id 决定权限边界 — plan §D3）。
   *                  child 是 Pick<TaskRecord, 'ownerSessionId' | 'teamId'>。
   * @returns 实际被删除的所有 task id 列表（含 root + cascade 下游）。
   */
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
  /** Transfer ownership atomically, preserving teams, edges and updated_at. */
  reassignOwner(oldSessionId: string, newSessionId: string): number;
}

export const UPDATABLE_KEYS: ReadonlyArray<keyof TaskCreateInput> = [
  'subject',
  'description',
  'status',
  'activeForm',
  'priority',
  'blocks',
  'blockedBy',
  'labels',
  'teamId',
  // Ownership is intentionally excluded; handoff uses reassignOwner.
];

export const COL_MAP: Record<keyof TaskCreateInput, string> = {
  ownerSessionId: 'owner_session_id',
  teamId: 'team_id', // v024
  subject: 'subject',
  description: 'description',
  status: 'status',
  activeForm: 'active_form',
  priority: 'priority',
  blocks: 'blocks',
  blockedBy: 'blocked_by',
  labels: 'labels',
};

/**
 * 把 update patch 的 JS 值转为 SQL 列值。数组 → JSON.stringify。
 */
export function toColumnValue(key: keyof TaskCreateInput, value: unknown): unknown {
  if (key === 'blocks' || key === 'blockedBy' || key === 'labels') {
    return JSON.stringify(value ?? []);
  }
  return value ?? null;
}
