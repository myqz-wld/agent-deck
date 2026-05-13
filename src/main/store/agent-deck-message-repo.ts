/**
 * Agent Deck Universal Team Backend message repo（R3.E3 / E0 ADR §4）。
 *
 * 持久层：agent_deck_messages 表 CRUD + watcher 关键 helpers。
 *
 * 设计要点：
 * - 同步 SQL（与 task-repo / session-repo / agent-deck-team-repo 风格一致）
 * - WAL + 单进程，FK 在 db.ts 内已启用
 * - 通过 `createAgentDeckMessageRepo(db)` 工厂注入 db；默认导出 `agentDeckMessageRepo` 懒拿 getDb()
 *
 * 状态机（ADR §4.3）：
 *   pending → claim → delivering →
 *     ↓ success: delivered (terminal)
 *     ↓ throw:   pending (attempt_count++ + last_attempt_at=now) | failed (>= MAX_RETRY)
 *   或 cancelled (terminal, 来自显式 cancel API)
 *
 * 关键修法（reviewer 双对抗）：
 * - HIGH-1：用 last_attempt_at 而非 sent_at 做退避基准（findEligible WHERE 子句）
 * - HIGH-1 / MED-2：MAX_RETRY=3，attempt_count 取值 {0,1,2,3}，3 直接 failed
 * - §4.6：crash recovery 不无条件 ++attempt_count（resetDeliveringOnStartup）
 * - 自循环防御：caller-side insert 校验 from != to
 * - 100KB body：caller-side validation + SQLite CHECK 兜底
 */
import type { Database } from 'better-sqlite3';
import type { AgentDeckMessage, AgentDeckMessageStatus } from '@shared/types';
import { getDb } from './db';

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

export class MessageInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageInvariantError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Constants（与 ADR §4.3 一致；可被 settings 覆盖见 watcher §4）
// ────────────────────────────────────────────────────────────────────────────

export const MAX_RETRY = 3;
export const MAX_BODY_LENGTH = 102_400; // 100 KB hard cap（SQLite CHECK 同款）

/**
 * 退避表（ADR §4.3 / reviewer HIGH-1 修法）：
 * - attempt_count = 1 → 1s
 * - attempt_count = 2 → 4s
 * - attempt_count = 3 → never picked（直接 failed）
 *
 * 输入：当前 attempt_count（已 ++ 后的值）
 * 输出：距离 last_attempt_at 至少 N 毫秒后才 eligible
 */
export function backoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  if (attemptCount === 1) return 1_000;
  if (attemptCount === 2) return 4_000;
  // attempt_count >= 3：never eligible，调用方应已设 status='failed' 不会进 findEligible
  return Number.MAX_SAFE_INTEGER;
}

// ────────────────────────────────────────────────────────────────────────────
// 行 → record 转换
// ────────────────────────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  team_id: string;
  from_session_id: string;
  to_session_id: string;
  body: string;
  status: string;
  status_reason: string | null;
  sent_at: number;
  delivered_at: number | null;
  attempt_count: number;
  last_attempt_at: number | null;
  delivering_since: number | null;
  reply_to_message_id: string | null;
}

function rowToRecord(r: MessageRow): AgentDeckMessage {
  // status: SQL CHECK 已挡，理论上不应到这里有非法值；防御性 fallback 到 'failed'
  const validStatuses: AgentDeckMessageStatus[] = [
    'pending',
    'delivering',
    'delivered',
    'failed',
    'cancelled',
  ];
  const status = (validStatuses as string[]).includes(r.status)
    ? (r.status as AgentDeckMessageStatus)
    : 'failed';
  return {
    id: r.id,
    teamId: r.team_id,
    fromSessionId: r.from_session_id,
    toSessionId: r.to_session_id,
    body: r.body,
    status,
    statusReason: r.status_reason,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
    attemptCount: r.attempt_count,
    lastAttemptAt: r.last_attempt_at,
    deliveringSince: r.delivering_since,
    replyToMessageId: r.reply_to_message_id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Input shapes
// ────────────────────────────────────────────────────────────────────────────

export interface InsertMessageInput {
  /**
   * plan team-cohesion-fix-20260513 Phase B7：可选预先生成的 id（默认 crypto.randomUUID()）。
   * spawn_session 路径用 —— 需要在 createSession 之前知道 placeholder messageId 才能拼到
   * prompt 顶部 `[msg <id>]` prefix（让 teammate 收到 prompt 后能 regex 提 id 调 reply_message）。
   */
  id?: string;
  teamId: string;
  fromSessionId: string;
  toSessionId: string;
  /** 1-100KB；caller-side 校验 + SQL CHECK 兜底 */
  body: string;
  /**
   * plan team-cohesion-fix-20260513 Phase B Step B1：对话链关联（可选）。
   * 非 NULL 时建立"这是对某条 msg 的 reply"语义；wait_reply 走此字段反查。
   * caller-side 不强制校验 reply_to_message_id 真实存在（FK ON DELETE SET NULL 兜底）。
   */
  replyToMessageId?: string | null;
}

export interface ListMessagesByTeamOptions {
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
  /** 仅返回特定状态 */
  status?: AgentDeckMessageStatus;
}

export interface FindEligibleOptions {
  /** 当前时间戳（毫秒）；watcher 注入便于测试 */
  now: number;
  /** 单批 LIMIT；默认 16 */
  limit?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Repo
// ────────────────────────────────────────────────────────────────────────────

export interface AgentDeckMessageRepo {
  /**
   * 入队一条消息（status='pending', sent_at=now, last_attempt_at=null）。
   *
   * Caller-side 校验：
   * - body 非空 + 长度 ≤ MAX_BODY_LENGTH（与 SQL CHECK 双层防御）
   * - from != to（自循环消息直接 throw）
   *
   * **不**校验 team 存在 / from-to 同 team / archived team —— 这些上层（IPC handler /
   * MCP send_message tool）必须先校验，repo 仅做行级数据完整性。
   */
  insert(input: InsertMessageInput): AgentDeckMessage;
  get(messageId: string): AgentDeckMessage | null;
  listByTeam(teamId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[];
  /**
   * plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2：按 session 维度拉 cross-session
   * messages（from_session_id = sid OR to_session_id = sid）。SessionDetail 「跨会话消息」tab
   * 兜底用：J fix（§决策 1）让 reply 不再 inject 给 sender SDK 后，lead 没主动 wait_reply /
   * check_reply 时看不到 reply —— 此 method 提供 DB 视角全量可视化。
   *
   * 包含：本 session 发出的 send + 收到的 send + 本 session 发出的 reply + 收到的 reply。
   * 排序与 listByTeam 一致 ORDER BY sent_at DESC（最新在前）。
   */
  listBySession(sessionId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[];
  /**
   * plan team-cohesion-fix-20260513 Phase B Step B1：反查某条 msg 的所有 reply。
   *
   * SQL 走 idx_messages_reply_to 部分索引（v015）。按 sent_at ASC 排序保证 FIFO；
   * wait_reply tool 用此查最早一条 reply（first reply）作为 trigger 条件。
   */
  findRepliesByMessageId(messageId: string): AgentDeckMessage[];

  // ─── watcher 关键 helpers（§4.1 / §4.3） ───
  /**
   * 取「现在 eligible 投递」的消息：status='pending' 且
   * (last_attempt_at IS NULL OR last_attempt_at + backoff(attempt_count) <= now)。
   *
   * 按 sent_at ASC 排序保证 FIFO；LIMIT 控制单轮处理量（默认 16）。
   *
   * 注：本方法只查不改；调用方逐个 row 用 claim() 原子化抢占。
   */
  findEligible(opts: FindEligibleOptions): AgentDeckMessage[];
  /**
   * 原子化抢占：UPDATE ... WHERE id=? AND status='pending' RETURNING *。
   * 多个 watcher 实例 / 多 tick 并发不会重复 claim 同一行。
   *
   * 成功返回更新后 row（status='delivering', delivering_since=now, last_attempt_at=now）；
   * 失败（已被别人 claim / 状态变了）返回 null。
   */
  claim(messageId: string, now: number): AgentDeckMessage | null;
  /** 投递成功 → terminal */
  markDelivered(messageId: string, now: number): AgentDeckMessage | null;
  /** 失败超出 MAX_RETRY 或 caller 主动放弃 → terminal */
  markFailed(messageId: string, reason: string): AgentDeckMessage | null;
  /**
   * 退避后下次再试：attempt_count++ + last_attempt_at=now + status='pending'。
   * 调用方在 watcher 内 catch adapter.receiveTeammateMessage error 后调；
   * 内部判断如 attempt_count >= MAX_RETRY 自动 markFailed。
   */
  retryAfterFail(messageId: string, reason: string, now: number): AgentDeckMessage | null;
  /** 显式 cancel（lead 撤回 / team archive 后兜底）→ terminal */
  cancel(messageId: string, reason: string): AgentDeckMessage | null;
  /** per-target backpressure：to_session_id 当前 in-flight count（pending + delivering） */
  countPendingForTarget(toSessionId: string): number;
  /**
   * 进程 crash recovery（§4.6）：把上次进程崩溃时卡在 delivering 的行重置为 pending，
   * **不** ++attempt_count（避免 crash 把还有重试余量的行直接拍 failed）。
   * 返回 reset 行数。
   */
  resetDeliveringOnStartup(): number;
}

export function createAgentDeckMessageRepo(db: Database): AgentDeckMessageRepo {
  function insert(input: InsertMessageInput): AgentDeckMessage {
    const { teamId, fromSessionId, toSessionId, body } = input;
    if (fromSessionId === toSessionId) {
      throw new MessageInvariantError(
        `self-message not allowed: from=${fromSessionId} == to=${toSessionId}`,
      );
    }
    if (!body || body.length === 0) {
      throw new MessageInvariantError('body 不能为空');
    }
    if (body.length > MAX_BODY_LENGTH) {
      throw new MessageInvariantError(
        `body 长度 ${body.length} 超过 ${MAX_BODY_LENGTH}`,
      );
    }

    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    // plan team-cohesion-fix-20260513 Phase B Step B1：reply_to_message_id 列入 INSERT
    db.prepare(
      `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, 0, NULL, NULL, ?)`,
    ).run(id, teamId, fromSessionId, toSessionId, body, now, input.replyToMessageId ?? null);

    const created = get(id);
    if (!created) throw new Error(`message ${id} 创建后查询失败`);
    return created;
  }

  function get(messageId: string): AgentDeckMessage | null {
    const row = db
      .prepare(`SELECT * FROM agent_deck_messages WHERE id = ?`)
      .get(messageId) as MessageRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  function listByTeam(teamId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    if (opts?.status) {
      const rows = db
        .prepare(
          `SELECT * FROM agent_deck_messages
           WHERE team_id = ? AND status = ?
           ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
        )
        .all(teamId, opts.status, limit, offset) as MessageRow[];
      return rows.map(rowToRecord);
    }
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_messages
         WHERE team_id = ?
         ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
      )
      .all(teamId, limit, offset) as MessageRow[];
    return rows.map(rowToRecord);
  }

  function listBySession(sessionId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[] {
    // plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2：from_session_id OR to_session_id
    // 命中即返回。SessionDetail tab 兜底视图（J fix 后 reply 不入 SDK，此处 DB 视角补回）。
    // 不走 idx_messages_sent_at（无法两个谓词都索引），扫表 + WHERE filter，rows ≤ 几千问题不大。
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    if (opts?.status) {
      const rows = db
        .prepare(
          `SELECT * FROM agent_deck_messages
           WHERE (from_session_id = ? OR to_session_id = ?) AND status = ?
           ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
        )
        .all(sessionId, sessionId, opts.status, limit, offset) as MessageRow[];
      return rows.map(rowToRecord);
    }
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_messages
         WHERE from_session_id = ? OR to_session_id = ?
         ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
      )
      .all(sessionId, sessionId, limit, offset) as MessageRow[];
    return rows.map(rowToRecord);
  }

  function findRepliesByMessageId(messageId: string): AgentDeckMessage[] {
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_messages
         WHERE reply_to_message_id = ?
         ORDER BY sent_at ASC`,
      )
      .all(messageId) as MessageRow[];
    return rows.map(rowToRecord);
  }

  function findEligible(opts: FindEligibleOptions): AgentDeckMessage[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 16, 100));
    // backoff 是连续函数：用 SQL 表达 (last_attempt_at IS NULL OR last_attempt_at + backoff(attempt_count) <= now)
    // backoff(attempt_count) 在 SQL 里展开成 CASE，避免引入 sqlite custom fn
    // attempt_count: 0 → 不用退避（last_attempt_at IS NULL 兜底）
    // attempt_count: 1 → +1000ms
    // attempt_count: 2 → +4000ms
    // attempt_count: 3 → never eligible（直接 failed，不在 status='pending'）
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_messages
         WHERE status = 'pending'
           AND (
             last_attempt_at IS NULL
             OR (
               attempt_count = 1 AND last_attempt_at + 1000 <= ?
             )
             OR (
               attempt_count = 2 AND last_attempt_at + 4000 <= ?
             )
             OR (
               attempt_count = 0
             )
           )
         ORDER BY sent_at ASC
         LIMIT ?`,
      )
      .all(opts.now, opts.now, limit) as MessageRow[];
    return rows.map(rowToRecord);
  }

  function claim(messageId: string, now: number): AgentDeckMessage | null {
    // RETURNING 在 better-sqlite3 + sqlite 3.35+ 支持
    const updated = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'delivering', delivering_since = ?, last_attempt_at = ?
         WHERE id = ? AND status = 'pending'
         RETURNING *`,
      )
      .get(now, now, messageId) as MessageRow | undefined;
    return updated ? rowToRecord(updated) : null;
  }

  function markDelivered(messageId: string, now: number): AgentDeckMessage | null {
    // REVIEW_32 HIGH-1：接纳 status='pending' OR 'delivering'。
    // spawn_session 路径在 SDK createSession 已经投过 prompt，紧接着 insert placeholder
    // (status='pending') + markDelivered 做「捷径 mark 为 delivered，watcher 不再重投」。
    // 旧 SQL 仅匹配 'delivering' → spawn 路径 100% no-op → universal-message-watcher 250ms
    // poll 命中 (pending, last_attempt_at IS NULL) → 二次投递（teammate 跑完首条 prompt 后立刻
    // 又收到一份 wireBody = `[from <name>][msg <id>]\n` + 原 body）。fix：放宽 status 集合。
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'delivered', delivered_at = ?, status_reason = NULL,
             delivering_since = NULL
         WHERE id = ? AND status IN ('pending', 'delivering')`,
      )
      .run(now, messageId);
    if (result.changes === 0) return null;
    return get(messageId);
  }

  function markFailed(messageId: string, reason: string): AgentDeckMessage | null {
    // 允许从 delivering / pending 任一态进 failed（caller 主动放弃）
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'failed', status_reason = ?, delivering_since = NULL
         WHERE id = ? AND status IN ('pending', 'delivering')`,
      )
      .run(reason, messageId);
    if (result.changes === 0) return null;
    return get(messageId);
  }

  function retryAfterFail(messageId: string, reason: string, now: number): AgentDeckMessage | null {
    // 只能从 delivering 退回 pending（claim 后失败）
    const cur = db
      .prepare(`SELECT * FROM agent_deck_messages WHERE id = ?`)
      .get(messageId) as MessageRow | undefined;
    if (!cur) return null;
    if (cur.status !== 'delivering') return null;

    const newAttemptCount = cur.attempt_count + 1;
    if (newAttemptCount >= MAX_RETRY) {
      return markFailed(
        messageId,
        `retry-exhausted (attempt=${newAttemptCount}): ${reason}`,
      );
    }
    db.prepare(
      `UPDATE agent_deck_messages
       SET status = 'pending', attempt_count = ?, last_attempt_at = ?,
           status_reason = ?, delivering_since = NULL
       WHERE id = ? AND status = 'delivering'`,
    ).run(newAttemptCount, now, reason, messageId);
    return get(messageId);
  }

  function cancel(messageId: string, reason: string): AgentDeckMessage | null {
    // 仅可从 pending / delivering 进 cancelled；terminal 态拒
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'cancelled', status_reason = ?, delivering_since = NULL
         WHERE id = ? AND status IN ('pending', 'delivering')`,
      )
      .run(reason, messageId);
    if (result.changes === 0) return null;
    return get(messageId);
  }

  function countPendingForTarget(toSessionId: string): number {
    const row = db
      .prepare(
        `SELECT count(*) AS c FROM agent_deck_messages
         WHERE to_session_id = ? AND status IN ('pending', 'delivering')`,
      )
      .get(toSessionId) as { c: number };
    return row.c;
  }

  function resetDeliveringOnStartup(): number {
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'pending',
             status_reason = 'recovered-from-delivering (process restart)',
             delivering_since = NULL
         WHERE status = 'delivering'`,
      )
      .run();
    return result.changes;
  }

  return {
    insert,
    get,
    listByTeam,
    listBySession,
    findEligible,
    claim,
    markDelivered,
    markFailed,
    retryAfterFail,
    cancel,
    countPendingForTarget,
    resetDeliveringOnStartup,
    findRepliesByMessageId,
  };
}

/** 默认 repo：模块加载时 getDb() 还没 init，不能 eager 构造；缓存到模块 closure */
let _defaultRepo: AgentDeckMessageRepo | null = null;
function defaultRepo(): AgentDeckMessageRepo {
  if (!_defaultRepo) _defaultRepo = createAgentDeckMessageRepo(getDb());
  return _defaultRepo;
}

export const agentDeckMessageRepo: AgentDeckMessageRepo = {
  insert: (input) => defaultRepo().insert(input),
  get: (messageId) => defaultRepo().get(messageId),
  listByTeam: (teamId, opts) => defaultRepo().listByTeam(teamId, opts),
  listBySession: (sessionId, opts) => defaultRepo().listBySession(sessionId, opts),
  findEligible: (opts) => defaultRepo().findEligible(opts),
  claim: (messageId, now) => defaultRepo().claim(messageId, now),
  markDelivered: (messageId, now) => defaultRepo().markDelivered(messageId, now),
  markFailed: (messageId, reason) => defaultRepo().markFailed(messageId, reason),
  retryAfterFail: (messageId, reason, now) => defaultRepo().retryAfterFail(messageId, reason, now),
  cancel: (messageId, reason) => defaultRepo().cancel(messageId, reason),
  countPendingForTarget: (toSessionId) => defaultRepo().countPendingForTarget(toSessionId),
  resetDeliveringOnStartup: () => defaultRepo().resetDeliveringOnStartup(),
  findRepliesByMessageId: (messageId) => defaultRepo().findRepliesByMessageId(messageId),
};
