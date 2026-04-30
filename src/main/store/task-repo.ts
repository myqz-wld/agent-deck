/**
 * Task Manager 持久层（v007 / CHANGELOG_41）。
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
 * 与 team 机制（v006 sessions.team_name + ~/.claude/teams/<name>/ fs 视图）适配：
 * - tasks.team_name TEXT 可空：null = 全局任务；非 null = 该 team 范围共享
 * - team 在 fs 被 Claude 删掉**不联动**删 task（保留为 orphan，与 sessions.team_name
 *   同语义；UI 后续可以标灰）
 * - 与 ~/.claude/tasks/<team>/<list>.md 的 Claude 自然语言任务**互补**而非覆盖：
 *   两套并行存在，互不同步
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
  team_name: string | null;
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
    teamName: r.team_name,
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
  subject: string;
  description?: string | null;
  status?: TaskStatus;
  activeForm?: string | null;
  priority?: number;
  blocks?: string[];
  blockedBy?: string[];
  labels?: string[];
  teamName?: string | null;
}

export interface TaskListOptions {
  /** 仅返回该状态。不传 = 不过滤 */
  status?: TaskStatus;
  /** subject 模糊匹配（大小写不敏感 contains）。不传 = 不过滤 */
  subjectKeyword?: string;
  /**
   * 三态：
   * - 不传 / undefined = 全部任务（含全局 + 所有 team）
   * - 传 string = 仅该 team
   * - 传 null = 仅全局任务（team_name IS NULL）
   */
  teamName?: string | null;
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
   * **teamName 不能通过 update 改**（REVIEW_17 H1 顺带修复 L9）：tool 层闭包锁
   * 设计上禁止跨 team 改 task，但如果 repo.update 接受 teamName key，未来直调 repo
   * 的 ts 脚本能绕过 closure。这里在 repo 层主动忽略 patch 里的 teamName key
   * （不抛错，避免破坏「Partial 接口宽容」）。
   */
  update(id: string, patch: Partial<TaskCreateInput>): TaskRecord | null;
  /**
   * 删除一条 task，cascade=true 时按 blocks 链路 BFS 级联下游。
   *
   * @param predicate 可选 cascade 路径过滤器：cascade BFS 入队前调
   *                  predicate(childId, childTeamName)，返回 false 则该 child
   *                  及其下游都不进 toDelete 集合。tool 层用此挡跨 team 删除
   *                  （REVIEW_17 H1）：传 `(_, t) => t === currentTeam`。
   */
  delete(
    id: string,
    opts?: { cascade?: boolean; predicate?: (id: string, teamName: string | null) => boolean },
  ): boolean;
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
  // teamName 故意不在 UPDATABLE_KEYS（REVIEW_17 H1 / L9）：tool 层闭包锁禁止跨
  // team 改 task，repo 层主动忽略 patch.teamName，防止未来直调 repo 的 ts 脚本
  // 绕过 closure。如要 reset task 的 teamName 必须 delete + 重新 create。
];

const COL_MAP: Record<keyof TaskCreateInput, string> = {
  subject: 'subject',
  description: 'description',
  status: 'status',
  activeForm: 'active_form',
  priority: 'priority',
  blocks: 'blocks',
  blockedBy: 'blocked_by',
  labels: 'labels',
  teamName: 'team_name',
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
    const now = new Date().toISOString();
    const rec: TaskRecord = {
      id: crypto.randomUUID(),
      teamName: input.teamName ?? null,
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
       (id, team_name, subject, description, status, active_form, priority,
        blocks, blocked_by, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.id,
      rec.teamName,
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
    if (opts.teamName === null) {
      wheres.push('team_name IS NULL');
    } else if (typeof opts.teamName === 'string') {
      wheres.push('team_name = ?');
      params.push(opts.teamName);
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
    const updatedAt = new Date().toISOString();
    sets.push('updated_at = ?');
    params.push(updatedAt);
    params.push(id);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return get(id);
  }

  function del(
    id: string,
    opts: { cascade?: boolean; predicate?: (id: string, teamName: string | null) => boolean } = {},
  ): boolean {
    const target = get(id);
    if (!target) return false;

    // 收集所有要删的 id：cascade=true 时递归把 target.blocks 链路下游全部并入。
    // 用 BFS + 已访问集合防自循环（虽然 spec §5 不做循环检测，但 cascade 内不能因
    // 数据里碰巧有环就死循环）。
    //
    // REVIEW_17 H1 修复：cascade BFS 入队前调 predicate(childId, childTeamName)，
    // 不通过的 child 整个不进 toDelete（含其自身 + 自己的 blocks 下游）。tool 层
    // 用此挡跨 team 删除：predicate = `(_, t) => t === currentTeam`。target 自身
    // 的 team 校验由 tool 层在调 repo.delete 之前做（不通过这里 short-circuit），
    // 保留 repo 层「单条 delete 不感知 team」的最小语义。
    const toDelete = new Set<string>([id]);
    if (opts.cascade) {
      const queue = [...target.blocks];
      while (queue.length) {
        const next = queue.shift()!;
        if (toDelete.has(next)) continue;
        const child = get(next);
        if (!child) continue;
        if (opts.predicate && !opts.predicate(child.id, child.teamName)) {
          // 跨 team child 整个跳过（不进 toDelete + 不展开它自己的 blocks）
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
        // 仅当真发生变化才 UPDATE，避免 N+1 写放大
        const origBlocks = JSON.parse(s.blocks) as unknown;
        const origBlockedBy = JSON.parse(s.blocked_by) as unknown;
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
    return true;
  }

  return { create, get, list, update, delete: del };
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
};
