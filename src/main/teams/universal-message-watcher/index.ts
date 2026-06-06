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
 * **wire format**（§4.4，CHANGELOG_100 / plan mcp-tool-simplify-20260514 D9：双锚点）：
 *   `[from <displayName> @ <adapterId>][msg <id>][sid <senderSessionId>]\n<原始 body>`
 * adapter 端不再二次封装；body 直接 sendMessage 到 receiver。
 * teammate（reviewer-* / 其他 mcp-aware agent）收到后从顶部 regex
 * `\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]` 提 messageId + senderSessionId 双锚点，调
 * `send_message({ sessionId: senderSid, teamId, text, replyToMessageId: messageId })` 回 lead；
 * reply 走与普通 message 同款 dispatch（universal-message-watcher.deliver → adapter）自动注入
 * receiver SDK conversation（reply_message / wait_reply / check_reply 三 tool 已 CHANGELOG_100 删，
 * 见本文件 deliver() 内 J fix 注释）。
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
import { messageRateLimiter } from './rate-limiter';
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
  teamId: string | null,
): { displayName: string; adapterId: string } {
  const session = sessionRepo.get(fromSessionId);
  // adapter 已删时走二级 fallback（避免 `null:abcd1234`）
  const adapterId = session?.agentId ?? 'unknown-adapter';
  // plan teamless-dm-20260601 D6：teamless DM（teamId=null）无 team membership 可查 → 直接走
  // fallback。优先 session.title（用户可见名，如 "reviewer-claude · batch A"），缺失再退
  // `<adapterId>:<sid 前 8>`。team 模式下保留 REVIEW_35 MED-A2 的 PK lookup（O(log N) 复合索引）。
  if (teamId !== null) {
    const myMembership = agentDeckTeamRepo.findActiveMembershipIn(teamId, fromSessionId);
    if (myMembership?.displayName && myMembership.displayName.trim()) {
      return { displayName: myMembership.displayName, adapterId };
    }
  } else if (session?.title && session.title.trim()) {
    return { displayName: session.title, adapterId };
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

  /** 应用启动调一次。idempotent：重复调不会起多个 timer。 */
  start(opts?: { pollIntervalMs?: number }): void {
    if (this.pollInterval) return;
    this.running = true;
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

  stop(): void {
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
    const claimNow = Date.now();
    const claimed = agentDeckMessageRepo.claim(message.id, claimNow);
    if (!claimed) {
      // 已被别的 tick / 测试中的并发 claim 抢走，跳过
      return;
    }
    this.emitStatus(claimed);

    // **REVIEW_86 MED-1 (reviewer-codex)**: claim 已把行置 'delivering'，但 claim 后的 invariant
    // 重验（sessionRepo.get / agentDeckTeamRepo.get / findActiveMembershipIn）+ buildWireBody 旧版
    // **在 adapter try/catch 之外**。任一同步抛错（SQLITE_BUSY / I/O / DB lock）冒到 process() 外层
    // catch 只 warn，不 retryAfterFail / 不 markFailed → 行永久卡 'delivering'，而 findEligible 仅扫
    // 'pending' → 运行期不再重投，只有下次 start() 的 resetDeliveringOnStartup() 能救（需重启）。
    // 修法:把整段 post-claim（invariant 重验 + buildWireBody + adapter call）包进一个 try；catch
    // 内对 claimed.id 调 retryAfterFail（退避后重投，到 MAX_RETRY 自动 failed），确保所有 post-claim
    // 异常都走状态机不会卡 delivering。invariant 违规路径（markFailed + return）是 by-design 终止态，
    // return 正常退出 try 不进 catch，行为不变。
    try {
      await this.dispatchClaimed(claimed);
    } catch (err) {
      // claim 后任意同步/异步异常（invariant 重验 DB 抛错 / buildWireBody 抛错 / 未被内层 adapter
      // try 捕获的其他抛错）统一退避重投，破开「永久卡 delivering」。
      const reason = err instanceof Error ? err.message : String(err);
      const updated = agentDeckMessageRepo.retryAfterFail(claimed.id, reason, Date.now());
      if (updated) {
        this.emitStatus(updated);
        logger.warn(
          `[universal-message-watcher] deliver post-claim error (attempt ${updated.attemptCount}/${MAX_RETRY}) message=${updated.id}: ${reason}`,
        );
      }
    }
  }

  /**
   * claim 之后的投递主体：5 项 invariant 重验 → adapter resolve → buildWireBody → adapter call。
   * 抽出让 deliver() 的 outer try 能兜住本段任意 post-claim 抛错（REVIEW_86 MED-1）。
   * invariant 违规走 markFailed + return（终止态，by-design）；adapter call 失败走内层 retryAfterFail。
   */
  private async dispatchClaimed(claimed: AgentDeckMessage): Promise<void> {
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

    // REVIEW_56 Batch C R1 codex MED-1 修法: enqueue 时 send.ts 校验 caller/target 共享 active
    // team(+ archived check),但 enqueue 与 deliver 之间发生 team archive / from leave team /
    // to leave team / from archived / target archived 任一种 → claim 后 dispatch 已 stale。
    // ipc/teams.ts:155 AgentDeckTeamArchive handler 只 emit event 不 cancel pending message
    // (ipc 路径不知 message-repo);watcher 是 dispatch 路径最后一道闸门 → claim 后重验 invariant
    // 失败 markFailed 不 dispatch,防止向已 archive / leave 的 receiver 投递。
    // (cancel pending 主动清理是 follow-up optimization;watcher 重验是充分的正确性 invariant。)
    //
    // **session 级闸门**（target archived / from not found / from archived）对 team + teamless
    // **都适用**，留在 teamless guard 外（plan teamless-dm-20260601 D5）。
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
    // **team 级闸门**（team exists / team archived / from-to active membership）仅 team 消息适用。
    // plan teamless-dm-20260601 D5：teamless DM（teamId=null）无 team / membership 概念 → 整段短路。
    // membership 是 peer-ACL，teamless 已由 RFC 放弃（§不变量 9）；上面 session 级安全闸门保留。
    // 同时 `agentDeckTeamRepo.get(claimed.teamId)` 要求非 null string，guard 也消解类型。
    if (claimed.teamId !== null) {
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
      return;
    }

    try {
      const delivered = agentDeckMessageRepo.markDelivered(claimed.id, Date.now());
      if (delivered) this.emitStatus(delivered);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[universal-message-watcher] markDelivered failed after adapter accepted message=${claimed.id}; not retrying to avoid duplicate receiver injection: ${reason}`,
      );
      try {
        const failed = agentDeckMessageRepo.markFailed(
          claimed.id,
          `post-delivery markDelivered failed after adapter accepted; not retried: ${reason}`,
        );
        if (failed) this.emitStatus(failed);
      } catch (markFailedErr) {
        logger.warn(
          `[universal-message-watcher] markFailed also failed after markDelivered failure message=${claimed.id}:`,
          markFailedErr,
        );
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
