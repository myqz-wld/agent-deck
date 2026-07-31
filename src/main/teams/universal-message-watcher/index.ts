/**
 * Cross-adapter message delivery. Enqueue events provide the fast path while polling covers missed
 * events, retry deadlines, and crash recovery. Claims are atomic and accepted deliveries are
 * at-most-once. Wire bodies carry message and sender-session anchors so replies use the same
 * durable dispatch path as ordinary messages; closed targets fail explicitly.
 */

import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { eventBus } from '@main/event-bus';
import {
  agentDeckMessageRepo,
  deliveryLeaseOf,
} from '@main/store/agent-deck-message-repo';
import { settingsStore } from '@main/store/settings-store';
import {
  MAX_RETRY,
  MESSAGE_DELIVERY_DURABILITY,
} from '@main/store/message-delivery-state';
import type { AgentDeckMessage } from '@shared/types';

import { dispatchClaimedMessage } from './claimed-message-delivery';
import { teamEventDispatcher } from './team-event-dispatcher';
import { messageRateLimiter } from './rate-limiter';
import log from '@main/utils/logger';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';

const logger = log.scope('universal-message-watcher');

// Public module facade for the watcher and its rate limiter.
export { PerKeyRateLimiter, messageRateLimiter } from './rate-limiter';
export { enqueueAgentDeckMessage, type EnqueueMessageInput } from './enqueue';
export { teamEventDispatcher } from './team-event-dispatcher';

/** 默认 poll 节奏；测试可注入更短 tick 加速。 */
const DEFAULT_POLL_INTERVAL_MS = 250;
/** event 触发后的 debounce 间隔（防 burst burst 多个 enqueue 重复 process）。 */
const ENQUEUE_DEBOUNCE_MS = 50;
/** 单 tick 单批 claim 上限（避免单次循环吃光 event-loop）。 */
const BATCH_LIMIT = 16;
export const MESSAGE_DELIVERY_DRAIN_TIMEOUT_MS = 5_000;

export interface MessageDeliveryDrainResult {
  drained: boolean;
  timedOut: boolean;
  activeDeliveries: number;
  durableDelivering: number;
}

// ────────────────────────────────────────────────────────────────────────────
// UniversalMessageWatcher 主类
// ────────────────────────────────────────────────────────────────────────────

export class UniversalMessageWatcher {
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  /** REVIEW_86 LOW (reviewer-claude): per-team rate-limiter 空桶低频清理 timer（防 Map 随历史 team 增长）。 */
  private sweepInterval: NodeJS.Timeout | null = null;
  private offEnqueue: (() => void) | null = null;
  /** 单飞：同一 tick 内多次触发只跑一次（防 event + poll burst 串行重入）。 */
  private processing = false;
  /** 收到 enqueue event 但还在 processing 时，flag 置 true，processing 完后立刻 reschedule。 */
  private rescheduleAfterCurrent = false;
  /**
   * **REVIEW_100 LOW (reviewer-codex)**: running/stopped 状态闸门。`stop()` 只清 timer / listener
   * 但不清 `rescheduleAfterCurrent` + `finally` 无 stopped guard → in-flight process() tick 期间
   * poll/event 置 rescheduleAfterCurrent=true 后 before-quit 调 stop()，当前 tick 结束仍
   * `setImmediate(process)` 再跑一轮，在 shutdown 语义之后继续 claim/deliver 并与 adapterRegistry
   * .shutdownAll()(lifecycle-hooks.ts:90,在 watcher.stop() L82 之后)竞争。修法:running flag
   * 在 finally reschedule 前 gate + stop() 清 rescheduleAfterCurrent。
   */
  private running = false;
  /**
   * Claimed adapter calls still executing in this process. A cleared entry is not proof of a
   * durable outcome; waitForDrain also probes delivering rows from the repository.
   */
  private readonly activeDeliveries = new Map<
    string,
    { fromSessionId: string; toSessionId: string }
  >();

  /** 应用启动调一次。idempotent：重复调不会起多个 timer。 */
  start(opts?: { pollIntervalMs?: number }): void {
    if (this.pollInterval) return;
    this.running = true;
    // Post-acceptance at-most-once recovery: a leftover delivering row may already have reached
    // the receiver, so make it terminal instead of making it eligible for another injection.
    try {
      const terminalized = agentDeckMessageRepo.terminalizeDeliveringOnStartup();
      if (terminalized > 0) {
        logger.info(
          `[universal-message-watcher] startup: terminalized ${terminalized} uncertain delivering rows (${MESSAGE_DELIVERY_DURABILITY})`,
        );
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

    // REVIEW_86 LOW (reviewer-claude): per-team rate-limiter 空桶低频清理（每 60s = rate 窗口长度）。
    // 全部 timestamp 出窗的桶整桶删，防 buckets Map 随历史 team（含 archived）单调增长。
    // 用独立低频 timer 而非 poll tick（250ms 太频繁，sweep 无需那么勤）。unref 让它不阻止进程退出。
    this.sweepInterval = setInterval(() => {
      messageRateLimiter.sweepEmptyBuckets();
    }, 60_000);
    this.sweepInterval.unref?.();

    teamEventDispatcher.start();

    logger.info(
      `[universal-message-watcher] started (poll=${tickMs}ms, debounce=${ENQUEUE_DEBOUNCE_MS}ms, batch=${BATCH_LIMIT})`,
    );
  }

  async stop(
    options: { timeoutMs?: number } = {},
  ): Promise<MessageDeliveryDrainResult> {
    this.running = false;
    // **REVIEW_100 LOW (reviewer-codex)**: 清 rescheduleAfterCurrent，防 in-flight process() 的
    // finally 在 stop 后仍 setImmediate 再跑一轮（shutdown 语义后继续 claim/deliver + 与
    // adapterRegistry.shutdownAll 竞争）。配合 finally 的 running guard 双保险。
    this.rescheduleAfterCurrent = false;
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
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    teamEventDispatcher.stop();
    const result = await this.waitForDrain(
      () => this.activeDeliveries.size,
      options.timeoutMs ?? MESSAGE_DELIVERY_DRAIN_TIMEOUT_MS,
    );
    logger.info(
      '[message-delivery-drain]',
      safeDiagnostic({
        event: 'message-delivery-drain',
        runId: getProcessRunId(),
        scope: 'watcher-stop',
        outcome: result.drained ? 'drained' : 'timeout',
        activeDeliveries: result.activeDeliveries,
        durableDelivering: result.durableDelivering,
      }),
    );
    return result;
  }

  /**
   * The cutover lease must already be active. It blocks new source ingress and this watcher's
   * pre-claim gate; this method only drains claims that crossed the boundary earlier.
   */
  async drainForHandOff(
    sessionId: string,
    timeoutMs = MESSAGE_DELIVERY_DRAIN_TIMEOUT_MS,
  ): Promise<MessageDeliveryDrainResult> {
    const result = await this.waitForDrain(
      () => {
        let active = 0;
        for (const delivery of this.activeDeliveries.values()) {
          if (
            delivery.fromSessionId === sessionId ||
            delivery.toSessionId === sessionId
          ) active += 1;
        }
        return active;
      },
      timeoutMs,
      sessionId,
    );
    logger.info(
      '[message-delivery-drain]',
      safeDiagnostic({
        event: 'message-delivery-drain',
        runId: getProcessRunId(),
        scope: 'handoff',
        sessionId,
        outcome: result.drained ? 'drained' : 'timeout',
        activeDeliveries: result.activeDeliveries,
        durableDelivering: result.durableDelivering,
      }),
    );
    return result;
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
    // **REVIEW_100 R2 LOW (reviewer-codex) — 入口 stopped guard，补全 commit 15b0080**:
    // 15b0080 修住「in-flight process() 的 finally 在 stop 后再 setImmediate」，但
    // **已 queued 的 setImmediate(process) callback 拦不住** — stop 前已排入 event loop 的
    // callback，stop 清 timer/flag 后仍会轮到执行进 process() 查库/claim/deliver，在 shutdown
    // 语义后与 adapterRegistry.shutdownAll() 竞争。入口 `!running` 直接早退是所有异步入口的
    // 终极闸门（poll tick / debounce / setImmediate reschedule 三条 callback 路径统一拦住）。
    if (!this.running) return;
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

      // **REVIEW_86 MED (reviewer-claude + reviewer-codex 反驳轮共识)**: 旧 starvation guard 用
      // **全局** deliveredAny 标志，over-cap target X 被 under-cap target Y 的持续流量饿死——
      // X(pending 12-15) 每 candidate `otherInflight=count-1 > maxInflight` 全 skip，但 Y under-cap
      // deliver 置 deliveredAny=true → L245 guard（!deliveredAny 才救）被 Y 掩盖跳过；L256 cross-target
      // 二阶段仅在 batch 撑爆且救 batch **外** target（X 已在 batch 内救不到）。X 每 tick drain 0 无限饿死。
      // codex 反驳轮补充：X=15/Y=1（batch=16）+ X≥16（drain 到 15 后停）同样命中——只要 Y 持续 trickle。
      // 修法（codex 安全设计）：保留 REVIEW_35 的 `count-1`（防同 target 死锁）+ REVIEW_56 的 cross-target
      // 二阶段（救 batch 外 target），额外 per-target 记录「本 tick 被 backpressure skip 的 target 的
      // head candidate」+「本 tick 有成功 deliver 的 target 集合」；主 loop 后对每个被 skip 且**本 tick
      // 零进展**的 over-cap target 强制 deliver 其 head 一条，保证每个 over-cap target 每 tick ≥1 进展。
      let deliveredAny = false;
      const deliveredTargets = new Set<string>();
      const firstSkippedByTarget = new Map<string, AgentDeckMessage>();
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
          // 记录每个 over-cap target 的 head candidate（FIFO 最早），供 loop 后 per-target rescue。
          if (!firstSkippedByTarget.has(candidate.toSessionId)) {
            firstSkippedByTarget.set(candidate.toSessionId, candidate);
          }
          continue;
        }
        await this.deliver(candidate);
        if (!this.running) return;
        deliveredAny = true;
        deliveredTargets.add(candidate.toSessionId);
      }
      // REVIEW_86 MED per-target rescue：对每个本 tick 被 backpressure skip 且零成功 deliver 的
      // over-cap target，强制 deliver 其 head 一条破开闸门——保证 over-cap target 不被其他 target
      // 流量无限饿死。代价同 REVIEW_35 guard：偶尔微超 cap 一条（deliver 后 count 降回）。这取代旧
      // 全局 deliveredAny guard（L245）——per-target 视角严格更强（旧 guard 只在全局零 deliver 时救
      // candidates[0] 一个 target，新逻辑救所有零进展 over-cap target）。
      for (const [toSessionId, head] of firstSkippedByTarget) {
        if (!deliveredTargets.has(toSessionId)) {
          await this.deliver(head);
          if (!this.running) return;
          deliveredAny = true;
          deliveredTargets.add(toSessionId);
        }
      }
      // 兜底：candidates 非空但全程零 deliver（理论上 per-target rescue 已覆盖所有 over-cap skip，
      // 此处仅防御「candidates 非空但既无 under-cap deliver 又无 firstSkippedByTarget」的不可达组合）。
      if (!deliveredAny && candidates.length > 0) {
        await this.deliver(candidates[0]);
        if (!this.running) return;
      }
      // REVIEW_56 Batch C R1 codex MED-2 修法:cross-target starvation 二阶段公平兜底。
      // per-target rescue 救的是 batch **内** 被 skip 的 over-cap target;但 batch 全是 target-X 撑爆
      // BATCH_LIMIT 时,batch **外** 的 target-Y 根本进不了 candidates → 需 secondary query 救。
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
          if (!this.running) return;
        }
      }
    } catch (err) {
      logger.warn('[universal-message-watcher] process tick failed:', err);
    } finally {
      this.processing = false;
      // **REVIEW_100 LOW (reviewer-codex)**: running guard — stop() 后不再 reschedule。
      // 否则 in-flight tick 期间 stop() 被调（before-quit），当前 tick 结束仍 setImmediate 再跑一轮，
      // 在 shutdown 语义之后继续 claim/deliver + 与 adapterRegistry.shutdownAll() 竞争。
      if (this.running && this.rescheduleAfterCurrent) {
        this.rescheduleAfterCurrent = false;
        // 立刻再跑一轮（处理 processing 期间新 enqueue 的 message）
        setImmediate(() => void this.process());
      }
    }
  }

  /** 单条投递：claim → adapter call → markDelivered | retry。 */
  private async deliver(message: AgentDeckMessage): Promise<void> {
    // The handoff lease is the pre-claim boundary. Pending envelopes remain durable and are
    // retargeted transactionally only after every older claim has drained.
    if (
      handOffCutoverCoordinator.isActive(message.fromSessionId) ||
      handOffCutoverCoordinator.isActive(message.toSessionId)
    ) return;
    const claimNow = Date.now();
    const claimed = agentDeckMessageRepo.claim(message.id, claimNow);
    if (!claimed) {
      // 已被别的 tick / 测试中的并发 claim 抢走，跳过
      return;
    }
    this.emitStatus(claimed);
    const lease = deliveryLeaseOf(claimed);
    this.activeDeliveries.set(claimed.id, {
      fromSessionId: claimed.fromSessionId,
      toSessionId: claimed.toSessionId,
    });

    // **REVIEW_86 MED-1 (reviewer-codex)**: claim 已把行置 'delivering'，但 claim 后的 invariant
    // 重验（sessionRepo.get / agentDeckTeamRepo.get / findActiveMembershipIn）+ buildWireBody 旧版
    // **在 adapter try/catch 之外**。任一同步抛错（SQLITE_BUSY / I/O / DB lock）冒到 process() 外层
    // catch 只 warn，不 retryAfterFail / 不 markFailed → 行永久卡 'delivering'，而 findEligible 仅扫
    // 'pending'。旧 recovery 会在重启后重投；当前 at-most-once recovery 会终止它，因此明确发生在
    // acceptance 前的异常必须在本进程内可靠地退回 pending。
    // 修法:把整段 post-claim（invariant 重验 + buildWireBody + adapter call）包进一个 try；catch
    // 内对 adapter acceptance 之前的异常调 retryAfterFail（退避后重投，到 MAX_RETRY 自动 failed）。
    // dispatchClaimedMessage 自己封住 acceptance 之后的 durable-write failure，禁止 outer catch 把已
    // 接受的消息退回 pending。invariant 违规路径（markFailed + return）是 by-design 终止态。
    try {
      await dispatchClaimedMessage({
        claimed,
        lease,
        emitStatus: (message) => this.emitStatus(message),
      });
    } catch (err) {
      // Acceptance 之前的同步/异步异常（invariant 重验 DB 抛错 / buildWireBody 抛错 / 未被
      // dispatch 内层捕获的异常）统一退避重投，破开「永久卡 delivering」。
      const reason = err instanceof Error ? err.message : String(err);
      const updated = agentDeckMessageRepo.retryAfterFail(lease, reason, Date.now());
      if (updated) {
        this.emitStatus(updated);
        logger.warn(
          `[universal-message-watcher] deliver post-claim error (attempt ${updated.attemptCount}/${MAX_RETRY}) message=${updated.id}: ${reason}`,
        );
      }
    } finally {
      this.activeDeliveries.delete(claimed.id);
    }
  }

  private async waitForDrain(
    activeCount: () => number,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<MessageDeliveryDrainResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const activeDeliveries = activeCount();
      let durableDelivering = 0;
      try {
        durableDelivering = sessionId
          ? agentDeckMessageRepo.countDeliveringForSession(sessionId)
          : agentDeckMessageRepo.countDelivering();
      } catch (error) {
        logger.warn(
          '[message-delivery-drain] durable probe failed',
          safeErrorSummary(error),
        );
        durableDelivering = Math.max(1, activeDeliveries);
      }
      if (activeDeliveries === 0 && durableDelivering === 0) {
        return {
          drained: true,
          timedOut: false,
          activeDeliveries,
          durableDelivering,
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          drained: false,
          timedOut: true,
          activeDeliveries,
          durableDelivering,
        };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, remaining));
        timer.unref?.();
      });
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
