/**
 * Task Manager 持久层（plan task-mcp-owner-session-id-rewrite-20260521 v023 重设计）。
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
 * v023 重设计（plan §D1-D6）：
 * - tasks 表唯一 owner 字段 owner_session_id NOT NULL REFERENCES sessions(id)
 *   ON DELETE CASCADE，task 必有 owner，无 global task 概念
 * - team scope 由 query 层 reverse join sessions 表 → agent_deck_team_members 算出来；
 *   task-repo 不直接 join team_members 表 —— team-aware list 留在 tool 层用
 *   agent_deck_team_repo helper 先算「caller 同 team active member sids」再调
 *   task-repo.list({ownerSessionIds: ids[]}) IN 过滤
 * - hand_off 过继：上层 tool 调 reassignOwner(oldSid, newSid) 单 SQL 改 owner
 *
 * 已知限制（与 spec §5 / §7 一致）：
 * - 不做 blocks / blockedBy 循环依赖检测
 * - subject / description 长度等业务校验放在 tool 层（Zod schema），repo 层只做
 *   存在性 + 数据完整性约束（subject 非空），保证 repo 单元测试不依赖 zod
 */
import type { Database } from 'better-sqlite3';
import type { TaskRecord, TaskStatus } from '@shared/types';
import { getDb } from './db';

interface Row {
  id: string;
  owner_session_id: string;
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
function safeJsonArray(raw: string, field: string, taskId: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
    console.warn(`[task-repo] task ${taskId} 字段 ${field} 不是 string[]，退化空数组：${raw}`);
    return [];
  } catch (e) {
    console.warn(`[task-repo] task ${taskId} 字段 ${field} JSON 解析失败，退化空数组：${e}`);
    return [];
  }
}

function rowToRecord(r: Row): TaskRecord {
  return {
    id: r.id,
    ownerSessionId: r.owner_session_id,
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

export interface TaskCreateInput {
  /** v023：必填，绑 caller session（tool 层从 caller_session_id 闭包注入）。 */
  ownerSessionId: string;
  subject: string;
  description?: string | null;
  status?: TaskStatus;
  activeForm?: string | null;
  priority?: number;
  blocks?: string[];
  blockedBy?: string[];
  labels?: string[];
}

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
   * tool 层 task_list 主路径：caller 视角 visible task = caller 自己 + 同 team
   * active member 的 task。tool 层先用 agent_deck_team_repo 算 active member sids
   * union {callerSid}，再调本接口 IN 过滤。
   */
  ownerSessionIds?: string[];
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
   * 增量更新。patch 中**显式传 undefined** 的字段会被忽略（视为「不动」），
   * 显式传 null 会被写入（用于把 description / activeForm 重置）。
   *
   * **ownerSessionId 不能通过 update 改**：tool 层闭包锁设计上禁止跨 session 改
   * owner（hand_off 走专用 reassignOwner 接口）。repo 层在 patch 里出现
   * ownerSessionId key 时主动忽略（不抛错，避免破坏「Partial 接口宽容」）。
   */
  update(id: string, patch: Partial<TaskCreateInput>): TaskRecord | null;
  /**
   * 删除一条 task，cascade=true 时按 blocks 链路 BFS 级联下游。
   *
   * @param predicate 可选 cascade 路径过滤器：cascade BFS 入队前调
   *                  predicate(childId, childOwnerSessionId)，返回 false 则该
   *                  child 及其下游都不进 toDelete 集合。tool 层用此挡跨 team
   *                  cascade 删除（写权限校验）。
   * @returns 实际被删除的所有 task id 列表（含 root + cascade 下游）。
   */
  delete(
    id: string,
    opts?: { cascade?: boolean; predicate?: (id: string, ownerSessionId: string) => boolean },
  ): string[];
  /**
   * v023 plan §D3 hand_off 过继：把 oldSessionId 拥有的所有 task 原子改成
   * newSessionId 拥有。单 SQL UPDATE，对应 hand_off_session tool 在 spawn 新
   * session 之后、archive caller 之前调（不可有窗口让 caller 被 archive 后 task
   * CASCADE 删但新 session 还没接管 —— plan §不变量 4）。
   *
   * @returns 被改写的行数。0 = caller 没拥有任何 task。
   */
  reassignOwner(oldSessionId: string, newSessionId: string): number;
}

const UPDATABLE_KEYS: ReadonlyArray<keyof TaskCreateInput> = [
  'subject',
  'description',
  'status',
  'activeForm',
  'priority',
  'blocks',
  'blockedBy',
  'labels',
  // ownerSessionId 故意不在 UPDATABLE_KEYS：tool 层闭包锁禁止跨 session 改 owner
  // （hand_off 走专用 reassignOwner 接口），repo 层主动忽略 patch.ownerSessionId。
];

const COL_MAP: Record<keyof TaskCreateInput, string> = {
  ownerSessionId: 'owner_session_id',
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
function toColumnValue(key: keyof TaskCreateInput, value: unknown): unknown {
  if (key === 'blocks' || key === 'blockedBy' || key === 'labels') {
    return JSON.stringify(value ?? []);
  }
  return value ?? null;
}

export function createTaskRepo(db: Database): TaskRepo {
  function get(id: string): TaskRecord | null {
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  function create(input: TaskCreateInput): TaskRecord {
    const subject = (input.subject ?? '').toString();
    if (!subject.trim()) {
      // store 层只做存在性校验，长度 / 字符集校验留给 tool 层 zod schema
      throw new Error('subject 不能为空');
    }
    const ownerSessionId = (input.ownerSessionId ?? '').toString();
    if (!ownerSessionId) {
      // v023 plan §不变量 1：task 必有 owner_session_id，repo 层兜底校验
      throw new Error('ownerSessionId 必填');
    }
    const now = new Date().toISOString();
    const rec: TaskRecord = {
      id: crypto.randomUUID(),
      ownerSessionId,
      subject,
      description: input.description ?? null,
      status: input.status ?? 'pending',
      activeForm: input.activeForm ?? null,
      priority: input.priority ?? 5,
      blocks: input.blocks ?? [],
      blockedBy: input.blockedBy ?? [],
      labels: input.labels ?? [],
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      `INSERT INTO tasks
       (id, owner_session_id, subject, description, status, active_form, priority,
        blocks, blocked_by, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.id,
      rec.ownerSessionId,
      rec.subject,
      rec.description,
      rec.status,
      rec.activeForm,
      rec.priority,
      JSON.stringify(rec.blocks),
      JSON.stringify(rec.blockedBy),
      JSON.stringify(rec.labels),
      rec.createdAt,
      rec.updatedAt,
    );
    return rec;
  }

  function list(opts: TaskListOptions = {}): TaskRecord[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      wheres.push('status = ?');
      params.push(opts.status);
    }
    if (opts.subjectKeyword) {
      wheres.push('LOWER(subject) LIKE ?');
      params.push(`%${opts.subjectKeyword.toLowerCase()}%`);
    }
    // v023 plan §D6：owner_session_id IN 过滤。空数组直接短路返 0 行
    // （SQL IN () 在 SQLite 里语法错，且语义上空集合本就 0 命中）。
    if (Array.isArray(opts.ownerSessionIds)) {
      if (opts.ownerSessionIds.length === 0) {
        return [];
      }
      const placeholders = opts.ownerSessionIds.map(() => '?').join(',');
      wheres.push(`owner_session_id IN (${placeholders})`);
      params.push(...opts.ownerSessionIds);
    }
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return rows.map(rowToRecord);
  }

  function update(id: string, patch: Partial<TaskCreateInput>): TaskRecord | null {
    const existing = get(id);
    if (!existing) return null;

    // 用 hasOwn 区分「显式传了 undefined」和「没传」：JSON 序列化场景下两者都是
    // key 不存在，所以本接口约定 undefined === 不动；想清空字段必须显式传 null。
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of UPDATABLE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      // subject 同 create：repo 层只挡 trim 后空字符串，长度等留给 tool 层 zod
      if (key === 'subject' && (!value || !String(value).trim())) {
        throw new Error('subject 不能更新为空');
      }
      sets.push(`${COL_MAP[key]} = ?`);
      params.push(toColumnValue(key, value));
    }
    if (sets.length === 0) {
      // patch 全是 ownerSessionId 或空：直接返回 existing 不改 updated_at
      return existing;
    }
    const updatedAt = new Date().toISOString();
    sets.push('updated_at = ?');
    params.push(updatedAt);
    params.push(id);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return get(id);
  }

  function del(
    id: string,
    opts: { cascade?: boolean; predicate?: (id: string, ownerSessionId: string) => boolean } = {},
  ): string[] {
    const target = get(id);
    if (!target) return [];

    const toDelete = new Set<string>([id]);
    if (opts.cascade) {
      const queue = [...target.blocks];
      while (queue.length) {
        const next = queue.shift()!;
        if (toDelete.has(next)) continue;
        const child = get(next);
        if (!child) continue;
        if (opts.predicate && !opts.predicate(child.id, child.ownerSessionId)) {
          continue;
        }
        toDelete.add(next);
        queue.push(...child.blocks);
      }
    }

    const tx = db.transaction(() => {
      // 1. 删除目标 + cascade 下游
      const placeholders = Array.from(toDelete).map(() => '?').join(',');
      db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...toDelete);

      // 2. 清理剩余 task 的 blocks / blocked_by 数组里指向已删 id 的引用。
      //    SQLite 的 JSON1 函数（json_each / json_remove）路径太绕，干脆 Node 端
      //    SELECT → 过滤 → UPDATE 写回。tasks 表通常规模不大（几百到几千），单次
      //    cascade 全表扫一遍可接受。如未来量大改 JSON1 函数也可以。
      const survivors = db.prepare(`SELECT id, blocks, blocked_by FROM tasks`).all() as Array<
        Pick<Row, 'id' | 'blocks' | 'blocked_by'>
      >;
      const cleanStmt = db.prepare(`UPDATE tasks SET blocks = ?, blocked_by = ? WHERE id = ?`);
      for (const s of survivors) {
        const blocks = safeJsonArray(s.blocks, 'blocks', s.id).filter((x) => !toDelete.has(x));
        const blockedBy = safeJsonArray(s.blocked_by, 'blocked_by', s.id).filter(
          (x) => !toDelete.has(x),
        );
        // 仅当真发生变化才 UPDATE,避免 N+1 写放大。
        //
        // **F6 修法**(deep-review Round 1 reviewer-codex LOW-1):裸 JSON.parse 包 try/catch,
        // 避免脏 JSON survivor 让删除一条无关 task 在 cleanup 阶段抛错并整个 tx 回滚。
        // safeJsonArray 已设计成「损坏退化空数组 + warn」保护 list / get 路径,但裸 parse
        // 破坏该容错。修后:裸 parse 失败 → 认为发生变化(原列损坏需要写回 clean JSON),
        // 与 safeJsonArray 容错语义对齐。
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
    });
    tx();
    // 返回所有被删的 id（含 root + cascade 下游），让 tools.ts task_delete 按 id
    // 逐个 emit task-changed，未来 Tasks tab 不会因为只 emit root 一次而 N-1 个
    // 下游 task UI stale。
    return Array.from(toDelete);
  }

  function reassignOwner(oldSessionId: string, newSessionId: string): number {
    // v023 plan §D3:hand_off_session tool 在 spawn 新 session 之后、archive
    // caller 之前调,原子把 caller 拥有的所有 task 转给新 session。
    //
    // FK 约束:newSessionId 必须在 sessions 表存在(不存在 → SQLite throw FK 错)。
    // 调用方(hand_off-session handler)保证新 session 已 spawn 落 DB 才调本接口。
    //
    // 单 SQL UPDATE,N 条 task 一次完成。FK 不在被改字段上(owner_session_id
    // 改值,新值合法即可),SQLite 不会触发 CASCADE 副作用。
    //
    // **F5 修法**(deep-review Round 1 reviewer-claude MED-c3):**不刷 updated_at**。
    // reassign 是 owner 换不是 task content 改,语义上不算用户「修改」task。修前刷
    // updated_at 让 hand_off baton 时 caller N 条 task 全部 updated_at 刷成同一毫秒
    // → list 默认 ORDER BY updated_at DESC 排序退化为 SQLite tie-break 顺序,大批量
    // reassign 后所有过继 task 浮到列表顶端,把新 session 真正最近改的 task 顶下去 →
    // UI stale。修后 reassignOwner 只改 owner_session_id,task 原 updated_at 保留 →
    // list 排序仍按 task 真实修改时间。
    const info = db
      .prepare(`UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?`)
      .run(newSessionId, oldSessionId);
    return Number(info.changes ?? 0);
  }

  return { create, get, list, update, delete: del, reassignOwner };
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
  reassignOwner: (oldSid, newSid) => defaultRepo().reassignOwner(oldSid, newSid),
};
