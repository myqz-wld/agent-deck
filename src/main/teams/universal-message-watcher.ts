/**
 * Universal Message Watcher (R3.E5 / ADR §4)
 *
 * Cross-adapter team message 投递引擎。从 `agent_deck_messages` 表 poll 出 pending 行，
 * 反查 receiver session 的 adapter，调 `adapter.receiveTeammateMessage` 把消息塞进
 * receiver 的 user turn，配重试 / 退避 / per-team rate limit / per-target backpressure /
 * crash recovery 一整套护栏。
 *
 * **调用方**：main bootstrap 启动 watcher.start()，关闭前调 watcher.stop()。
 *
 * **触发模式**（hybrid event + poll，§4.2）：
 * - event 触发（fast path）：messageRepo.insert 后 emit `agent-deck-message-enqueued`，
 *   watcher 监听后 50ms debounce 触发 process()
 * - poll 触发（兜底）：每 250ms 全量扫一次 status='pending'，覆盖 event 漏 emit /
 *   crash recovery / 退避到期重投
 *
 * **状态机**（§4.3）：pending → claim → delivering → delivered | (retry / failed)
 * - claim 用 `UPDATE ... WHERE status='pending' RETURNING` 原子化抢占
 * - throw 时 attemptCount ++ + lastAttemptAt = now → 退避后下次再选
 * - attemptCount >= 3 直接 failed
 *
 * **wire format**（§4.4，plan team-cohesion-fix-20260513 Phase B7：注入 messageId）：
 *   `[from <displayName> @ <adapterId>][msg <id>]\n<原始 body>`
 * adapter 端不再二次封装；body 直接 sendMessage 到 receiver。
 * teammate（reviewer-* / 其他 mcp-aware agent）收到后从顶部 regex `\[msg ([0-9a-f-]+)\]` 提
 * messageId，调 `reply_message({reply_to_message_id, text})` 回 lead；lead `wait_reply({message_id})`
 * 即可精确等到这条 reply（DB 按 reply_to_message_id 查 + listener fast path）。
 *
 * **sessionManager.close 兜底**：watcher 检测 receiver session lifecycle='closed' →
 * messageRepo.markFailed reason='session-closed'。wait-reply-coordinator 同步监听
 * `session-upserted.lifecycle='closed'` 让 lead 立即拿到 reason='session-closed' 结果。
 */

import type { AgentAdapter } from '@main/adapters/types';
import { adapterRegistry } from '@main/adapters/registry';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import {
  agentDeckMessageRepo,
  MAX_RETRY,
} from '@main/store/agent-deck-message-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { settingsStore } from '@main/store/settings-store';
import type {
  AgentDeckMessage,
  AgentDeckTeamMember,
  AgentDeckTeammateEvent,
} from '@shared/types';

/** 默认 poll 节奏；测试可注入更短 tick 加速。 */
const DEFAULT_POLL_INTERVAL_MS = 250;
/** event 触发后的 debounce 间隔（防 burst burst 多个 enqueue 重复 process）。 */
const ENQUEUE_DEBOUNCE_MS = 50;
/** 单 tick 单批 claim 上限（避免单次循环吃光 event-loop）。 */
const BATCH_LIMIT = 16;

// ────────────────────────────────────────────────────────────────────────────
// PerKey rate limiter (§7.5)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-key 滑动窗口限流（与 spawnRateLimiter 同款 patterns，但按 key 分桶）。
 * key = teamId；用 messageRepo.insert 入口校验：覆盖 IPC + MCP 两路。
 *
 * 同步操作（不 await），event-loop 单线程下无 race。
 */
export class PerKeyRateLimiter {
  private buckets = new Map<string, number[]>();

  constructor(
    private maxPerWindow: number,
    private windowMs: number,
  ) {}

  tryConsume(key: string, now = Date.now()): boolean {
    const arr = this.buckets.get(key) ?? [];
    const threshold = now - this.windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < threshold) i++;
    const fresh = i > 0 ? arr.slice(i) : arr;
    if (fresh.length >= this.maxPerWindow) {
      // 写回（如果裁剪过）
      if (i > 0) this.buckets.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.buckets.set(key, fresh);
    return true;
  }

  retryAfterMs(key: string, now = Date.now()): number {
    const arr = this.buckets.get(key);
    if (!arr || arr.length === 0) return 0;
    return Math.max(0, this.windowMs - (now - arr[0]));
  }

  setLimits(maxPerWindow: number, windowMs: number): void {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** 应用全局单例。messageRepo.insert 调用方（IPC + MCP send_message）入口校验。 */
export const messageRateLimiter = new PerKeyRateLimiter(60, 60_000);

/** caller-side 校验前缀拼装 + 入队的便利封装。caller 应用方都走此入口（统一 wire format）。 */
export interface EnqueueMessageInput {
  teamId: string;
  fromSessionId: string;
  toSessionId: string;
  body: string;
  /**
   * plan team-cohesion-fix-20260513 Phase B Step B1：可选对话链关联。
   * 非 NULL 时该 msg 是对 reply_to_message_id 指向的原 msg 的 reply（wait_reply 走此字段反查）。
   */
  replyToMessageId?: string | null;
}

/**
 * 入队一条 cross-adapter message（供 IPC handler / MCP send_message 调用）。
 *
 * 入口校验顺序：
 * 1. body 长度（messageRepo.insert 内部 100KB cap）
 * 2. self-message 防御（messageRepo.insert 内部）
 * 3. team / member 关系校验（caller 自己负责，因为 IPC vs MCP caller 有不同 ACL）
 * 4. per-team rate limit（settings.mcpMessageRatePerTeamPerMin，默认 60/min）
 *
 * **不**做「team active / archived」校验：archived team 的 send_message 由 caller 自己拒；
 * 此处入队只校验数据完整性（与老 messageRepo.insert 注释一致）。
 */
export function enqueueAgentDeckMessage(input: EnqueueMessageInput): {
  ok: true;
  message: AgentDeckMessage;
} | {
  ok: false;
  error: 'rate-limit-exceeded';
  retryAfterMs: number;
} {
  const limit = settingsStore.get('mcpMessageRatePerTeamPerMin') ?? 60;
  // 同步更新当前 limit 到 limiter（settings hot-toggle 立即生效）
  messageRateLimiter.setLimits(limit, 60_000);
  const now = Date.now();
  if (!messageRateLimiter.tryConsume(input.teamId, now)) {
    return {
      ok: false,
      error: 'rate-limit-exceeded',
      retryAfterMs: messageRateLimiter.retryAfterMs(input.teamId, now),
    };
  }
  const message = agentDeckMessageRepo.insert(input);
  // emit 让 watcher 立刻 process（debounced 50ms）
  eventBus.emit('agent-deck-message-enqueued', {
    id: message.id,
    teamId: message.teamId,
    fromSessionId: message.fromSessionId,
    toSessionId: message.toSessionId,
  });
  return { ok: true, message };
}

// ────────────────────────────────────────────────────────────────────────────
// fromMember displayName 反查（§4.4 wire format 前缀拼装）
// ────────────────────────────────────────────────────────────────────────────

function resolveFromDisplayName(
  fromSessionId: string,
  teamId: string,
): { displayName: string; adapterId: string } {
  const session = sessionRepo.get(fromSessionId);
  // adapter 已删时走二级 fallback（避免 `null:abcd1234`）
  const adapterId = session?.agentId ?? 'unknown-adapter';
  // 优先取该 team 的 display_name
  const members = agentDeckTeamRepo.listAllMembers(teamId);
  const myMembership = members.find((m) => m.sessionId === fromSessionId);
  if (myMembership?.displayName && myMembership.displayName.trim()) {
    return { displayName: myMembership.displayName, adapterId };
  }
  // fallback `<adapterId>:<sessionId 前 8 字符>`
  return {
    displayName: `${adapterId}:${fromSessionId.slice(0, 8)}`,
    adapterId,
  };
}

function buildWireBody(
  message: AgentDeckMessage,
): string {
  const { displayName, adapterId } = resolveFromDisplayName(
    message.fromSessionId,
    message.teamId,
  );
  // plan team-cohesion-fix-20260513 Phase B7：在 wire body 顶部注入 [msg <id>]，让 teammate
  // 能从 prompt 提 messageId 调 reply_message —— 否则 lead wait_reply({message_id}) 永 timeout
  // （teammate 不知 reply_to_message_id 该填啥，只能裸 message reply，wait_reply 查不到）。
  return `[from ${displayName} @ ${adapterId}][msg ${message.id}]\n${message.body}`;
}

// ────────────────────────────────────────────────────────────────────────────
// TeamEventDispatcher (§4.9) — best-effort notify adapter of teammate join/leave/archive
// ────────────────────────────────────────────────────────────────────────────

/**
 * 监听 `agent-deck-team-member-changed` / `agent-deck-team-updated` 然后 fan-out 给同 team
 * 所有 active member 的 adapter.notifyTeammateEvent。dispatcher 不等返回也不重试 ——
 * 这只是观察性事件。
 */
class TeamEventDispatcher {
  private offMember: (() => void) | null = null;
  private offUpdated: (() => void) | null = null;
  /** 缓存上次看到的 team archived_at，detect archive transition 用 */
  private lastArchivedAt = new Map<string, number | null>();

  start(): void {
    if (this.offMember) return;
    this.offMember = eventBus.on('agent-deck-team-member-changed', (ev) => {
      // 只关心 joined / left；role-changed 不触发 notify（团队 capability 没变）
      if (ev.kind === 'role-changed') return;
      const session = sessionRepo.get(ev.sessionId);
      const displayName = session?.title ?? ev.sessionId.slice(0, 8);
      const teammateEvent: AgentDeckTeammateEvent =
        ev.kind === 'joined'
          ? { kind: 'member-joined', teamId: ev.teamId, sessionId: ev.sessionId, displayName }
          : { kind: 'member-left', teamId: ev.teamId, sessionId: ev.sessionId, displayName };
      void this.fanOut(ev.teamId, teammateEvent, ev.sessionId);
    });
    this.offUpdated = eventBus.on('agent-deck-team-updated', (team) => {
      const prev = this.lastArchivedAt.get(team.id);
      const cur = team.archivedAt;
      this.lastArchivedAt.set(team.id, cur);
      if (prev === undefined) return; // 首次见到，不算变更
      // 仅关心从 active → archived 的变迁（unarchive 通常不需要打扰 active member）
      if (prev === null && cur !== null) {
        void this.fanOut(team.id, { kind: 'team-archived', teamId: team.id }, null);
      }
    });
  }

  stop(): void {
    this.offMember?.();
    this.offUpdated?.();
    this.offMember = null;
    this.offUpdated = null;
    this.lastArchivedAt.clear();
  }

  private async fanOut(
    teamId: string,
    event: AgentDeckTeammateEvent,
    excludeSessionId: string | null,
  ): Promise<void> {
    let members: AgentDeckTeamMember[];
    try {
      members = agentDeckTeamRepo.listActiveMembers(teamId);
    } catch (err) {
      console.warn(`[team-event-dispatcher] listActiveMembers failed for team ${teamId}:`, err);
      return;
    }
    const targets = members.filter((m) => m.sessionId !== excludeSessionId);
    await Promise.allSettled(
      targets.map((m) => this.notifyOne(m.sessionId, event)),
    );
  }

  private async notifyOne(sessionId: string, event: AgentDeckTeammateEvent): Promise<void> {
    const session = sessionRepo.get(sessionId);
    if (!session) return;
    const adapter = adapterRegistry.get(session.agentId);
    if (!adapter?.notifyTeammateEvent) return;
    try {
      await adapter.notifyTeammateEvent(sessionId, event);
    } catch (err) {
      // best-effort：不重试，仅 warn
      console.warn(
        `[team-event-dispatcher] notifyTeammateEvent failed for ${sessionId} (${session.agentId}):`,
        err,
      );
    }
  }
}

const teamEventDispatcher = new TeamEventDispatcher();
export { teamEventDispatcher };

// ────────────────────────────────────────────────────────────────────────────
// UniversalMessageWatcher 主类
// ────────────────────────────────────────────────────────────────────────────

export class UniversalMessageWatcher {
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private offEnqueue: (() => void) | null = null;
  /** 单飞：同一 tick 内多次触发只跑一次（防 event + poll burst 串行重入）。 */
  private processing = false;
  /** 收到 enqueue event 但还在 processing 时，flag 置 true，processing 完后立刻 reschedule。 */
  private rescheduleAfterCurrent = false;

  /** 应用启动调一次。idempotent：重复调不会起多个 timer。 */
  start(opts?: { pollIntervalMs?: number }): void {
    if (this.pollInterval) return;
    // crash recovery：把上次进程崩溃时卡在 delivering 的行重置为 pending（§4.6）
    try {
      const reset = agentDeckMessageRepo.resetDeliveringOnStartup();
      if (reset > 0) {
        console.log(`[universal-message-watcher] startup: reset ${reset} delivering rows to pending`);
      }
    } catch (err) {
      console.warn('[universal-message-watcher] startup recovery failed:', err);
    }

    this.offEnqueue = eventBus.on('agent-deck-message-enqueued', () => {
      this.scheduleDebounced();
    });

    const tickMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollInterval = setInterval(() => {
      void this.process();
    }, tickMs);

    teamEventDispatcher.start();

    console.log(
      `[universal-message-watcher] started (poll=${tickMs}ms, debounce=${ENQUEUE_DEBOUNCE_MS}ms, batch=${BATCH_LIMIT})`,
    );
  }

  stop(): void {
    this.offEnqueue?.();
    this.offEnqueue = null;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    teamEventDispatcher.stop();
    console.log('[universal-message-watcher] stopped');
  }

  /** event 触发后的 debounce：50ms 内多个 enqueue 合并为一次 process。 */
  private scheduleDebounced(): void {
    if (this.processing) {
      this.rescheduleAfterCurrent = true;
      return;
    }
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.process();
    }, ENQUEUE_DEBOUNCE_MS);
  }

  /**
   * 单 tick：拉一批 eligible message → 逐个 claim + 投递。
   * processing flag 防 reentry（poll + event 同时触发不会跑两遍）。
   */
  private async process(): Promise<void> {
    if (this.processing) {
      this.rescheduleAfterCurrent = true;
      return;
    }
    this.processing = true;
    try {
      const now = Date.now();
      const candidates = agentDeckMessageRepo.findEligible({ now, limit: BATCH_LIMIT });
      if (candidates.length === 0) return;

      // per-target backpressure 阈值同步当前 settings
      const maxInflight = settingsStore.get('mcpMessageMaxTargetInflight') ?? 10;

      for (const candidate of candidates) {
        // backpressure check（注：候选已经包含 status='pending' + 退避到期；现役 inflight count
        // 含 candidate 自身——还在 pending，未 claim）
        const inflight = agentDeckMessageRepo.countPendingForTarget(candidate.toSessionId);
        if (inflight > maxInflight) {
          // 跳过本 row 本轮；下次 poll 时若 inflight 降下来再选
          continue;
        }
        await this.deliver(candidate);
      }
    } catch (err) {
      console.warn('[universal-message-watcher] process tick failed:', err);
    } finally {
      this.processing = false;
      if (this.rescheduleAfterCurrent) {
        this.rescheduleAfterCurrent = false;
        // 立刻再跑一轮（处理 processing 期间新 enqueue 的 message）
        setImmediate(() => void this.process());
      }
    }
  }

  /** 单条投递：claim → adapter call → markDelivered | retry。 */
  private async deliver(message: AgentDeckMessage): Promise<void> {
    const claimNow = Date.now();
    const claimed = agentDeckMessageRepo.claim(message.id, claimNow);
    if (!claimed) {
      // 已被别的 tick / 测试中的并发 claim 抢走，跳过
      return;
    }
    this.emitStatus(claimed);

    const target = sessionRepo.get(claimed.toSessionId);
    if (!target) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'target session not found',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    if (target.lifecycle === 'closed') {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'target session is closed',
      );
      if (failed) this.emitStatus(failed);
      return;
    }

    let adapter: AgentAdapter | undefined;
    try {
      adapter = adapterRegistry.get(target.agentId);
    } catch {
      adapter = undefined;
    }
    if (!adapter) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        `adapter "${target.agentId}" not registered`,
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    if (!adapter.capabilities.canCollaborate || !adapter.receiveTeammateMessage) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        `adapter "${target.agentId}" does not support receiveTeammateMessage`,
      );
      if (failed) this.emitStatus(failed);
      return;
    }

    const wireBody = buildWireBody(claimed);
    try {
      await adapter.receiveTeammateMessage(
        claimed.toSessionId,
        claimed.fromSessionId,
        wireBody,
      );
      const delivered = agentDeckMessageRepo.markDelivered(claimed.id, Date.now());
      if (delivered) this.emitStatus(delivered);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const updated = agentDeckMessageRepo.retryAfterFail(claimed.id, reason, Date.now());
      if (updated) {
        this.emitStatus(updated);
        if (updated.status === 'pending') {
          console.warn(
            `[universal-message-watcher] deliver failed (attempt ${updated.attemptCount}/${MAX_RETRY}) message=${updated.id}: ${reason}`,
          );
        } else {
          console.warn(
            `[universal-message-watcher] deliver exhausted message=${updated.id}: ${reason}`,
          );
        }
      }
    }
  }

  private emitStatus(message: AgentDeckMessage): void {
    eventBus.emit('agent-deck-message-status-changed', {
      id: message.id,
      teamId: message.teamId,
      status: message.status,
      statusReason: message.statusReason,
    });
  }
}

export const universalMessageWatcher = new UniversalMessageWatcher();
