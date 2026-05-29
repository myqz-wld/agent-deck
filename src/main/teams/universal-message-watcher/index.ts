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
 *
 * **CHANGELOG_105 拆分**（universal-message-watcher-split-20260514）：原 581 LOC 单文件按
 * 档位 1 拆为：
 * - `rate-limiter.ts`        — PerKeyRateLimiter class + messageRateLimiter 单例
 * - `enqueue.ts`             — EnqueueMessageInput + enqueueAgentDeckMessage caller-facing 入队 API
 * - `team-event-dispatcher.ts` — TeamEventDispatcher class + teamEventDispatcher 单例
 * - `index.ts` (本文件)      — UniversalMessageWatcher 主类 + buildWireBody 内部 helper + 单例 + facade re-export
 * 外部 import 路径不变（TS module resolution 自动 fallback 到 index.ts）。
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
import { sanitizeWireFieldName } from '@shared/wire-prefix';
import type { AgentDeckMessage } from '@shared/types';

import { teamEventDispatcher } from './team-event-dispatcher';
import log from '@main/utils/logger';

const logger = log.scope('universal-message-watcher');

// facade re-export：保持外部 import 路径完全兼容
// (`from '@main/teams/universal-message-watcher'` → TS module resolution fallback 到 index.ts)
export { PerKeyRateLimiter, messageRateLimiter } from './rate-limiter';
export { enqueueAgentDeckMessage, type EnqueueMessageInput } from './enqueue';
export { teamEventDispatcher } from './team-event-dispatcher';

/** 默认 poll 节奏；测试可注入更短 tick 加速。 */
const DEFAULT_POLL_INTERVAL_MS = 250;
/** event 触发后的 debounce 间隔（防 burst burst 多个 enqueue 重复 process）。 */
const ENQUEUE_DEBOUNCE_MS = 50;
/** 单 tick 单批 claim 上限（避免单次循环吃光 event-loop）。 */
const BATCH_LIMIT = 16;

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
  // REVIEW_35 MED-A2：用 PK lookup 替代 listAllMembers 全表扫。high-volume team 单条 dispatch
  // 的 O(M_team) SQL 降到 O(log N)（走 (team_id, session_id) 复合索引）。
  const myMembership = agentDeckTeamRepo.findActiveMembershipIn(teamId, fromSessionId);
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
  // 能从 prompt 提 messageId 调 send_message —— 否则 lead 收到 reply 没有 reply chain anchor
  // （teammate 不知 reply_to_message_id 该填啥，只能裸 message reply）。
  // CHANGELOG_100 / plan mcp-tool-simplify-20260514 D9：升级双锚点 [msg <id>][sid <senderSessionId>]，
  // 让 teammate 拿到 senderSessionId 直接 send_message({session_id: sid, team_id, ...})
  // 回 lead，不必依赖 spawn 时注入的 lead context block / 不必 list_sessions 反查（双层冗余防
  // 协议漂移 / 长 prompt 截断）。
  // CHANGELOG_100 R2 fix (codex MED-1): sanitizeWireFieldName 处理 displayName / adapterId 里的
  // `]` / `\n` / `[`，避免 user 设的 session.title (e.g. "feat: [test]") 破坏 wire prefix 解析。
  const safeDisplayName = sanitizeWireFieldName(displayName);
  const safeAdapterId = sanitizeWireFieldName(adapterId);
  return `[from ${safeDisplayName} @ ${safeAdapterId}][msg ${message.id}][sid ${message.fromSessionId}]\n${message.body}`;
}

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
        logger.info(`[universal-message-watcher] startup: reset ${reset} delivering rows to pending`);
      }
    } catch (err) {
      logger.warn('[universal-message-watcher] startup recovery failed:', err);
    }

    this.offEnqueue = eventBus.on('agent-deck-message-enqueued', () => {
      this.scheduleDebounced();
    });

    const tickMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollInterval = setInterval(() => {
      void this.process();
    }, tickMs);

    teamEventDispatcher.start();

    logger.info(
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
    logger.info('[universal-message-watcher] stopped');
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

      let deliveredAny = false;
      for (const candidate of candidates) {
        // backpressure check：候选已经包含 status='pending' + 退避到期。
        // REVIEW_35 HIGH-A1：`countPendingForTarget` 返回 pending+delivering 之和，包含 candidate
        // 自身（candidate 在此处仍 pending、未 claim）。旧逻辑 `if (inflight > maxInflight) continue`
        // 让同一 target 入队 N=maxInflight+1 条 pending 后**永久死锁**：每条 candidate 都看 inflight=N
        // → 全部 continue → 无人 claim → count 不降。N≥BATCH_LIMIT(16) 同 target 时还会让 batch
        // 被同 target 占满，跨 target 也饿死（rA-claude Scenario D 实证）。
        // 修法：减掉 candidate 自身让本 candidate 永远能被 deliver，破开死锁。
        // 实际语义：「除 candidate 自身外，其他 in-flight ≤ maxInflight」，即每 tick 总能至少
        // deliver 1 条破开闸门；总 in-flight 上限 = maxInflight + 1。可接受微超 1 来避免死锁。
        const otherInflight =
          agentDeckMessageRepo.countPendingForTarget(candidate.toSessionId) - 1;
        if (otherInflight > maxInflight) {
          continue;
        }
        await this.deliver(candidate);
        deliveredAny = true;
      }
      // REVIEW_35 HIGH-A1 starvation guard：N >> maxInflight+1 同 target（典型：N≥17 撑爆 BATCH_LIMIT=16）
      // 时单 tick 所有 candidates 仍可能全 skip，跨 target 也饿死（其他 target 被挤出 batch）。
      // 修法：deliveredAny=false 且 candidates 非空 → 强制 deliver candidates[0] 破开闸门。
      // 代价：实际允许偶尔超 cap 一条短瞬窗口（candidate[0] deliver 完后 cap 降回）。这是
      // unbounded queue + bounded resource 经典 trade-off — 优先保活而非严格 cap。
      if (!deliveredAny && candidates.length > 0) {
        await this.deliver(candidates[0]);
      }
      // REVIEW_56 Batch C R1 codex MED-2 修法:cross-target starvation 二阶段公平兜底。
      // 上面 starvation guard 只 deliver candidates[0] = batch 内 FIFO 最早,但 batch 全是
      // target-X 时 (single target 撑爆 BATCH_LIMIT) candidates[0] 仍属 target-X → 跨 target
      // target-Y 仍 starve 数分钟(target-X queue 降到 < BATCH_LIMIT 前 Y 才进 batch)。
      // 修法:batch 撑爆 BATCH_LIMIT 时 (candidates.length >= BATCH_LIMIT) 跑 secondary
      // query 拉一条**不在 batch targets** 的最早 pending,公平投递破开闸门。
      // 触发条件: candidates.length >= BATCH_LIMIT 精确捕捉 batch 撑爆场景 — 不撑爆时
      // candidates 已含所有 eligible(无饿死),不必跑额外 SQL(避免 perf overhead)。
      if (candidates.length >= BATCH_LIMIT) {
        const batchTargets = Array.from(new Set(candidates.map((c) => c.toSessionId)));
        const fairCandidate = agentDeckMessageRepo.findEligibleExcludingTargets({
          now,
          excludeTargets: batchTargets,
        });
        if (fairCandidate) {
          await this.deliver(fairCandidate);
        }
      }
    } catch (err) {
      logger.warn('[universal-message-watcher] process tick failed:', err);
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

    // CHANGELOG_100 / plan mcp-tool-simplify-20260514：J fix 一刀切拦截已删除。
    //
    // 旧 J fix（CHANGELOG_99 之前）：`if (claimed.replyToMessageId != null)` 直接 markDelivered
    // + return，不 dispatch 给 sender SDK。当时是为了避免 lead 看到 wait_reply 拿到的 reply
    // 同时也作为 user-role message 被 inject 进 SDK conversation 重复显示。
    //
    // 但 CHANGELOG_99 反向发现：J fix 一刀切拦截了「lead 给 teammate 发消息时 caller 显式
    // 传 reply_to_message_id 链接 reply chain」场景 — teammate 不调 wait_reply 只能被动
    // 等 dispatch，被拦了永远收不到。
    //
    // CHANGELOG_100 协议大简化（删 reply_message + wait_reply + check_reply）：reply 现在
    // 走与普通 send_message 同款 dispatch 路径 → universal-message-watcher.deliver →
    // adapter.receiveTeammateMessage → adapter.sendMessage → sender SDK emit 'message'
    // kind 'user' role event → SessionDetail echo → lead/teammate 直接看到 reply 自动 act on
    // it。这跟收任意普通 message 同款处理路径，无特殊机制 — 一统协议。

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

    // REVIEW_56 Batch C R1 codex MED-1 修法: enqueue 时 send.ts:53 校验 caller/target 共享 active
    // team(+ archived check),但 enqueue 与 deliver 之间发生 team archive / from leave team /
    // to leave team / from archived / target archived 任一种 → claim 后 dispatch 已 stale。
    // ipc/teams.ts:155 AgentDeckTeamArchive handler 只 emit event 不 cancel pending message
    // (ipc 路径不知 message-repo);watcher 是 dispatch 路径最后一道闸门 → claim 后重验 5 项
    // invariant 失败 markFailed 不 dispatch,防止向已 archive / leave 的 receiver 投递。
    // (cancel pending 主动清理是 follow-up optimization;watcher 重验是充分的正确性 invariant。)
    if (target.archivedAt != null) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'target session archived',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    const fromSession = sessionRepo.get(claimed.fromSessionId);
    if (!fromSession) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'from session not found',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    if (fromSession.archivedAt != null) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'from session archived',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    const team = agentDeckTeamRepo.get(claimed.teamId);
    if (!team) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'team not found',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    if (team.archivedAt != null) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'team archived',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    const fromMembership = agentDeckTeamRepo.findActiveMembershipIn(
      claimed.teamId,
      claimed.fromSessionId,
    );
    const toMembership = agentDeckTeamRepo.findActiveMembershipIn(
      claimed.teamId,
      claimed.toSessionId,
    );
    if (!fromMembership && !toMembership) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'from and to no longer active members of team',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    if (!fromMembership) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'from no longer active member of team',
      );
      if (failed) this.emitStatus(failed);
      return;
    }
    if (!toMembership) {
      const failed = agentDeckMessageRepo.markFailed(
        claimed.id,
        'to no longer active member of team',
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
          logger.warn(
            `[universal-message-watcher] deliver failed (attempt ${updated.attemptCount}/${MAX_RETRY}) message=${updated.id}: ${reason}`,
          );
        } else {
          logger.warn(
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
