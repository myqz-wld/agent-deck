/**
 * agent-deck-message-repo 子模块共享类型 + helpers SSOT。
 *
 * 拆分自 `agent-deck-message-repo.ts` 527 LOC（Phase 4 Step 4.11，沿用 Step 4.5 task-repo
 * 同款 factory pattern）：
 * - MessageRow（SQLite schema 内部类型）+ rowToRecord（转 AgentDeckMessage）
 * - 4 Input shapes（InsertMessageInput / ListMessagesByTeamOptions /
 *   FindEligibleOptions / FindEligibleExcludingTargetsOptions）
 * - AgentDeckMessageRepo interface（13 method 主入口）
 * - getById free function（state-machine UPDATE 后反查最新 row 共享 SELECT）
 *
 * 子模块互相 type-only import 本文件保持 readability；运行时仅 rowToRecord / getById 是
 * value export。
 */
import type { Database } from 'better-sqlite3';
import type { AgentDeckMessage, AgentDeckMessageStatus } from '@shared/types';
import { coerceMessageStatus } from '@main/store/message-delivery-state';

// ────────────────────────────────────────────────────────────────────────────
// 行 → record 转换
// ────────────────────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  team_id: string | null;
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

export function rowToRecord(r: MessageRow): AgentDeckMessage {
  // status: SQL CHECK 已挡，理论上不应到这里有非法值；防御性 fallback 到 'failed'（详
  // message-delivery-state.ts coerceMessageStatus jsdoc）
  return {
    id: r.id,
    teamId: r.team_id,
    fromSessionId: r.from_session_id,
    toSessionId: r.to_session_id,
    body: r.body,
    status: coerceMessageStatus(r.status),
    statusReason: r.status_reason,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
    attemptCount: r.attempt_count,
    lastAttemptAt: r.last_attempt_at,
    deliveringSince: r.delivering_since,
    replyToMessageId: r.reply_to_message_id,
  };
}

/**
 * 通用 getById helper：跨子模块共享同款 SELECT 实现（避免重复 SQL）。
 * crud.get 直接复用；state-machine 4 method（markDelivered/markFailed/retryAfterFail/cancel）
 * UPDATE 后反查最新 row 共享。
 */
export function getById(db: Database, messageId: string): AgentDeckMessage | null {
  const row = db
    .prepare(`SELECT * FROM agent_deck_messages WHERE id = ?`)
    .get(messageId) as MessageRow | undefined;
  return row ? rowToRecord(row) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Input shapes
// ────────────────────────────────────────────────────────────────────────────

export interface InsertMessageInput {
  /**
   * plan team-cohesion-fix-20260513 Phase B7：可选预先生成的 id（默认 crypto.randomUUID()）。
   * spawn_session 路径用 —— 需要在 createSession 之前知道 placeholder messageId 才能拼到
   * prompt 顶部 `[msg <id>]` prefix（让 teammate 收到 prompt 后能 regex 提 id 调
   * send_message({ replyToMessageId })）。
   */
  id?: string;
  /** teamId=null = teamless DM（plan teamless-dm-20260601）。caller（send.ts / IPC）负责决定 team vs teamless。 */
  teamId: string | null;
  fromSessionId: string;
  toSessionId: string;
  /** 1-100KB；caller-side 校验 + SQL CHECK 兜底 */
  body: string;
  /**
   * plan team-cohesion-fix-20260513 Phase B Step B1：对话链关联（可选）。
   * 非 NULL 时建立"这是对某条 msg 的 reply"语义（reply 与普通 message 走同款 dispatch，
   * CHANGELOG_100 删 reply_message / wait_reply / check_reply 后 reply_to_message_id 仅作
   * 对话链元数据保留，无 reverse-lookup helper —— 详 crud.ts 末注释）。
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

/**
 * REVIEW_56 Batch C R1 codex MED-2 修法专用 options。
 *
 * 用途:解决 universal-message-watcher process() 撞 cross-target starvation 时的公平兜底
 * (单 target 17+ candidates 撑爆 BATCH_LIMIT=16 + starvation guard 只 deliver candidates[0]
 * 仍属同 target → 跨 target 饿死)。tick 内 detect starvation → 调本 helper 拉一条**不在
 * batch 内** target 的最早 pending,跨 target 公平投递破开闸门。
 */
export interface FindEligibleExcludingTargetsOptions {
  now: number;
  /** 排除的 target sessionId 列表(已在当前 batch 的 candidates) */
  excludeTargets: readonly string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Repo interface
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
   * 兜底用：CHANGELOG_100 协议简化后 reply 与普通 message 同款 dispatch 自动注入 receiver SDK，
   * 此 method 额外提供 DB 视角全量可视化（含已 delivered / failed 的历史消息）。
   *
   * 包含：本 session 发出的 send + 收到的 send + 本 session 发出的 reply + 收到的 reply。
   * 排序与 listByTeam 一致 ORDER BY sent_at DESC, rowid DESC（最新在前，rowid 二级定序保证
   * 同毫秒稳定 + 分页边界确定，REVIEW_90 修法）。
   */
  listBySession(sessionId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[];

  // ─── watcher 关键 helpers（§4.1 / §4.3） ───
  /**
   * 取「现在 eligible 投递」的消息：status='pending' 且
   * (last_attempt_at IS NULL OR last_attempt_at + backoff(attempt_count) <= now)。
   *
   * 按 sent_at ASC, rowid ASC 排序保证 FIFO（rowid 二级定序锁同毫秒入队稳定 oldest-first，
   * REVIEW_90 R2 修法）；LIMIT 控制单轮处理量（默认 16）。
   *
   * 注：本方法只查不改；调用方逐个 row 用 claim() 原子化抢占。
   */
  findEligible(opts: FindEligibleOptions): AgentDeckMessage[];
  /**
   * REVIEW_56 Batch C R1 codex MED-2 修法专用:取一条**不在 excludeTargets** 的最早 pending
   * eligible message。watcher process() detect cross-target starvation 时调,公平兜底投递。
   * 排序与 findEligible 一致(sent_at ASC, rowid ASC),LIMIT 1。
   *
   * - excludeTargets 空数组 → 等价 `findEligible({now, limit: 1})`
   * - 无符合返 null
   */
  findEligibleExcludingTargets(opts: FindEligibleExcludingTargetsOptions): AgentDeckMessage | null;
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
