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
import type { TaskRecord, TaskStatus } from '@shared/types';
import { getDb } from './db';

interface Row {
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

/**
 * v024 plan §D4 + Step B1:hand_off team_task_policy 'clear-team' / 'preserve-team' 两态
 * 走 reassignOwner 接口;'skip' 走独立 applyHandOffSkipPolicy helper（plan §不变量 11/12）。
 */
export type ReassignOwnerPolicy = 'clear-team' | 'preserve-team';

/**
 * v024 plan §D4 + Step B1:applyHandOffSkipPolicy helper return shape。
 * handler 端用 deletedTeamTaskIds 做后续 safeEmit task-changed deleted events;
 * count = deletedTeamTaskIds.length + reassignedPersonalCount 用于 ok return。
 */
export interface ApplyHandOffSkipResult {
  deletedTeamTaskIds: string[];
  reassignedPersonalCount: number;
}

export interface TaskRepo {
  create(input: TaskCreateInput): TaskRecord;
  get(id: string): TaskRecord | null;
  list(opts?: TaskListOptions): TaskRecord[];
  /**
   * 增量更新。patch 中**显式传 undefined** 的字段会被忽略（视为「不动」），
   * 显式传 null 会被写入（用于把 description / activeForm / teamId 重置）。
   *
   * v024 新增:teamId 可通过 update 改（用于 hand_off clear-team SET team_id=NULL
   * 但单条 task 路径,主路径走 reassignOwner({policy:'clear-team'}) 批量改）。
   *
   * **ownerSessionId 不能通过 update 改**：tool 层闭包锁设计上禁止跨 session 改
   * owner（hand_off 走专用 reassignOwner / applyHandOffSkipPolicy 接口）。repo 层
   * 在 patch 里出现 ownerSessionId key 时主动忽略（不抛错，避免破坏「Partial 接口宽容」）。
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
  /**
   * v023/v024 plan §D3 + D4 hand_off 过继：把 oldSessionId 拥有的所有 task 原子改成
   * newSessionId 拥有。单 SQL UPDATE，对应 hand_off_session tool 在 spawn 新
   * session 之后、archive caller 之前调（不可有窗口让 caller 被 archive 后 task
   * CASCADE 删但新 session 还没接管 — plan §不变量 4）。
   *
   * v024 plan §D4 加 policy 参数（HIGH-2 修法 + 不变量 12）:
   * - `'clear-team'`（default semantic）:UPDATE owner + team_id=NULL（过继 ownership
   *   同时清 team_id 变 personal,保最大兼容性 newSid 拿到的 task 都可写）
   * - `'preserve-team'`:UPDATE owner 不动 team_id（caller 自负保证 adopt_teammates=true
   *   让 newSid 接管 team 当 lead,否则撞 D3 写权限 reject — handler 加 policyWarning
   *   暴露根因 plan §不变量 5）
   * - **不含** `'skip'` — skip 走独立 applyHandOffSkipPolicy helper（不能放同 transaction:
   *   skip 真删 + cleanup blocks/blocked_by + reassign personal 三件事原子性需 helper 单
   *   transaction 收口）
   *
   * **不刷 updated_at**（v023 F5 修法,§不变量 11 沿用）:reassign 是 owner 换不是 task
   * content 改,语义上不算用户「修改」task,保留原 updated_at 让 list 默认排序稳定。
   *
   * @returns 被改写的行数。0 = caller 没拥有任何 task。
   */
  reassignOwner(
    oldSessionId: string,
    newSessionId: string,
    opts: { policy: ReassignOwnerPolicy },
  ): number;
  /**
   * v024 plan §D4 + Step B1（Round 3 MED-1 + Round 4 MED-2/3 + Round 6 MED-1 收口）:
   * hand_off team_task_policy='skip' 路径专用 helper — 单 db.transaction() 内原子化 4 步:
   *   1. SELECT id FROM tasks WHERE owner_session_id=callerSid AND team_id IS NOT NULL
   *      → 拿 deletedTeamTaskIds snapshot（handler 后续 safeEmit 用）
   *   2. chunked DELETE FROM tasks WHERE id IN (?)（CHUNK=500 防 IN 999 上限,与现有
   *      delete cascade 模式同款）
   *   3. blocks/blocked_by 引用 cleanup（同 transaction 内 SELECT survivors → 过滤
   *      引用 deletedTeamTaskIds 的项 → UPDATE 写回,与 delete cascade=false cleanup 同款）
   *   4. UPDATE tasks SET owner_session_id=newSid WHERE owner_session_id=callerSid
   *      AND team_id IS NULL → reassign 剩余 personal task
   *
   * 4 步在单个 db.transaction() 内,任一步 throw 整 tx 自动 ROLLBACK 保留原集（plan
   * §不变量 4 + Step B2 case B 测试锁定）。
   *
   * Handler 端 commit 后须按 returned deletedTeamTaskIds 显式 safeEmit task-changed
   * deleted events（per-id try/catch + console.warn + continue,沿用 hand-off-session.ts
   * :754-763 现有 safeEmit pattern — plan §不变量 11 + Step D2 单一伪代码块 outer try）。
   *
   * **不**走 reassignOwner({policy:'skip'})（reassignOwner 不含 'skip',skip 是 helper 唯一入口）。
   *
   * @returns deletedTeamTaskIds（被删的 team task id 列表）+ reassignedPersonalCount
   *          （被过继的 personal task 行数）;handler 拼 ok return.taskReassignment.count =
   *          deletedTeamTaskIds.length + reassignedPersonalCount。
   */
  applyHandOffSkipPolicy(callerSid: string, newSid: string): ApplyHandOffSkipResult;
  /**
   * v024 plan §Step D2 preserve-team safety 算法 helper（Round 4 HIGH-1 修法支撑）:
   * 返 caller (owner_session_id == callerSid) 拥有的 distinct non-null team_id 列表。
   *
   * hand_off `team_task_policy='preserve-team'` 路径用此 helper 拿 callerOwnedTeamIds
   * 与新 sid handoff 后 active teams (adoptedTeamIds ∪ spawnData.teamId) 比对差集，
   * 差集非空 → ok return.taskReassignment.policyWarning='preserve-team-unadopted-teams'
   * + unadoptedTeamIds 字段暴露根因（plan §不变量 5 + Step D2）。
   *
   * 单 SQL DISTINCT 一次拿到（避免 list 拉全部 task 然后 caller 端 map distinct）。
   *
   * @returns caller 拥有 task 的 distinct non-null team_id 列表（personal task team_id IS NULL 被排除）
   */
  findOwnedDistinctTeamIds(callerSid: string): string[];
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
  'teamId', // v024:允许 update 单条 task 改 teamId（hand_off 主路径走 reassignOwner 批量改）
  // ownerSessionId 故意不在 UPDATABLE_KEYS：tool 层闭包锁禁止跨 session 改 owner
  // （hand_off 走专用 reassignOwner / applyHandOffSkipPolicy 接口），repo 层主动忽略 patch.ownerSessionId。
];

const COL_MAP: Record<keyof TaskCreateInput, string> = {
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
      teamId: input.teamId ?? null, // v024 plan §D1 + D2:不传 = personal task
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
       (id, owner_session_id, team_id, subject, description, status, active_form, priority,
        blocks, blocked_by, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.id,
      rec.ownerSessionId,
      rec.teamId,
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
    // v024 plan §D5 + Step C5:visibleScope OR 模式优先于 ownerSessionIds + teamIdFilter
    //（task-list handler 三态分流时显式只传一个,visibleScope 与其他两个互斥）。
    if (opts.visibleScope !== undefined) {
      const { teamIds, callerSid } = opts.visibleScope;
      if (teamIds.length === 0) {
        // 空 teamIds → OR 退化为仅 personal task 分支:`team_id IS NULL AND owner_session_id = ?`
        wheres.push('(team_id IS NULL AND owner_session_id = ?)');
        params.push(callerSid);
      } else if (teamIds.length > 500) {
        // F2 同款 SQLite IN 999 上限防御 — caller 同 active team 数 > 500 极端病态场景
        console.warn(
          `[task-repo] listTasks: visibleScope.teamIds 长度 ${teamIds.length} 超 SQLite IN 上限 500,` +
            `返回空集 graceful degrade;caller 应清理历史 dormant teams 或 task-list handler 拆批。`,
        );
        return [];
      } else {
        const placeholders = teamIds.map(() => '?').join(',');
        // 完整 OR 模式:`(team_id IN teamIds) OR (team_id IS NULL AND owner_session_id = callerSid)`
        // 拿 caller 可见 team-bound task + 自己 personal task 一次 SQL 完成。
        wheres.push(`(team_id IN (${placeholders}) OR (team_id IS NULL AND owner_session_id = ?))`);
        params.push(...teamIds, callerSid);
      }
    } else {
      // 不走 visibleScope → 走 ownerSessionIds + teamIdFilter 组合 AND 过滤（v023 兼容路径）
      //
      // v023 plan §D6:owner_session_id IN 过滤。空数组直接短路返 0 行
      //（SQL IN () 在 SQLite 里语法错，且语义上空集合本就 0 命中）。
      if (Array.isArray(opts.ownerSessionIds)) {
        if (opts.ownerSessionIds.length === 0) {
          return [];
        }
        // F2 fix (deep-review-changelog146-20260524 R1 claude MED) — 详见原版本注释,沿用
        if (opts.ownerSessionIds.length > 500) {
          console.warn(
            `[task-repo] listTasks: ownerSessionIds 长度 ${opts.ownerSessionIds.length} 超 SQLite IN 上限 500,` +
              `返回空集 graceful degrade;caller 应清理历史 dormant session 或拆批查询。`,
          );
          return [];
        }
        const placeholders = opts.ownerSessionIds.map(() => '?').join(',');
        wheres.push(`owner_session_id IN (${placeholders})`);
        params.push(...opts.ownerSessionIds);
      }
      // v024 plan §D5:team_id 三态 filter（visibleScope 模式下忽略 teamIdFilter,仅这里生效）
      if (opts.teamIdFilter !== undefined) {
        if (opts.teamIdFilter === 'null-personal') {
          wheres.push('team_id IS NULL');
        } else {
          // string (team uuid)
          wheres.push('team_id = ?');
          params.push(opts.teamIdFilter);
        }
      }
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
    opts: {
      cascade?: boolean;
      predicate?: (
        id: string,
        child: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,
      ) => boolean;
    } = {},
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
      cleanupBlocksReferences(toDelete);
    });
    tx();
    // 返回所有被删的 id（含 root + cascade 下游）,让 tools.ts task_delete 按 id
    // 逐个 emit task-changed,未来 Tasks tab 不会因为只 emit root 一次而 N-1 个
    // 下游 task UI stale。
    return Array.from(toDelete);
  }

  /**
   * v024 plan §D4 + Step B1 — 提取 cleanup blocks/blocked_by 引用为 helper,让 del()
   * 与 applyHandOffSkipPolicy() 共享同款 cleanup 逻辑。
   *
   * **必须在 db.transaction() 内调**（不自开 tx,由 caller 保证原子性）。
   * SELECT survivors → 过滤 blocks/blocked_by 引用 deletedIds 的项 → UPDATE 写回。
   *
   * **F6 修法**(deep-review Round 1 reviewer-codex LOW-1):裸 JSON.parse 包 try/catch,
   * 避免脏 JSON survivor 让 cleanup 阶段抛错并整 tx 回滚。
   */
  function cleanupBlocksReferences(deletedIds: Set<string>): void {
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
        cleanupBlocksReferences(new Set(deletedTeamTaskIds));
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

  return {
    create,
    get,
    list,
    update,
    delete: del,
    reassignOwner,
    applyHandOffSkipPolicy,
    findOwnedDistinctTeamIds,
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
