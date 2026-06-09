/**
 * MessageLifecycleScheduler — 周期性扫描 agent_deck_messages 表，按 messageRetentionDays
 * 阈值硬删超期 terminal 消息（plan message-retention-and-index-20260602 §D2/§D6）。
 *
 * 与 src/main/store/issue-lifecycle-scheduler.ts 同款 `setInterval(tick, intervalMs)` pattern。
 *
 * **§D2 为何独立 scheduler**（不塞进 session LifecycleScheduler.scan）：那里已有 REVIEW_56/99
 * race fix 的复杂逻辑 + 60s tick 对 day 单位的 message GC 偏频繁 + 与 session GC 耦合。单一职责。
 *
 * **§D6 tick 节奏**：默认 6h（与 IssueLifecycleScheduler 对称——retention 单位是 day，GC 漂移
 * 几小时无害）。删满 limit（=可能还有积压）且本轮真删了行 → 调度 30s catch-up one-shot 续删，
 * 直到某轮删 < limit（积压清完回常态 6h）。
 *
 * **§N4 删除范围**：仅 `status IN ('delivered','failed','cancelled') AND sent_at < now - retentionMs`
 * （listExpiredForGc 走 v030 partial index）。pending/delivering 在途永不删。messageRetentionDays=0
 * → 跳过该路径 GC（N7）。teamless 与 team 统一阈值（不分桶）。
 *
 * **purged 事件**：每轮 batchHardDelete 后 deletedCount>0 才 emit 一次 `agent-deck-message-purged`
 * { count }，触发 renderer（MessagesPanel / TeamDetail 订阅 onAgentDeckMessageChanged）整体重拉
 * （§D7）。不逐条 emit（消息是 DELETE 非 status 变 + 最多 500 次过 debouncer 浪费）。
 */

import { agentDeckMessageRepo, GC_BATCH_LIMIT } from '@main/store/agent-deck-message-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const logger = log.scope('message-gc');

interface MessageSchedulerOptions {
  /** §D3 阈值：status IN terminal && sent_at < now - days*86400_000 → hardDelete。0 = 关闭 GC */
  messageRetentionDays: number;
  /** 调度间隔；默认 6h（§D6） */
  tickIntervalMs?: number;
  /** GC 单轮批量上限，传给 listExpiredForGc + 判定本轮是否删满（=还有积压）。默认 500 */
  gcBatchLimit?: number;
  /** 某轮删满 limit（还有积压）时调度的「续删 tick」短延迟。默认 30s */
  catchUpDelayMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 6 * 3600_000;
// impl-review claude INFO-1：默认批量上限引用 repo 的 GC_BATCH_LIMIT SSOT（= repo listExpiredForGc
// 内 Math.min cap），消除「scheduler default vs repo cap」两处硬编码漂移——否则 gcBatchLimit>cap
// 时 hitLimit 永 false 不排 catch-up，GC 退化每 6h 只删 cap 条追不上积压。
const DEFAULT_GC_BATCH_LIMIT = GC_BATCH_LIMIT;
const DEFAULT_CATCH_UP_DELAY_MS = 30_000;

export class MessageLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** 积压续删 one-shot timer（与常态 setInterval timer 独立）；stop() 一并清。 */
  private catchUpTimer: NodeJS.Timeout | null = null;
  constructor(private opts: MessageSchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    const tick = (): void => this.scan();
    tick();
    this.timer = setInterval(tick, this.opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 一并清 pending 续删 timer，防 stop 后 catch-up tick 仍碰 DB。
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
  }

  updateThresholds(opts: Partial<MessageSchedulerOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /**
   * §D6 GC tick：listExpiredForGc 拿超期 terminal id → batchHardDelete 单事务删 →
   * deletedCount>0 emit 一次 purged。messageRetentionDays<=0 早退（N7）。
   *
   * **每轮单次 emit 而非逐条**：renderer 整体重拉不解析 payload（MessagesPanel:61 /
   * TeamDetail:83），单次 { count } 足够；catch-up 多轮则每轮一次。
   *
   * **catch-up 守门 hitLimit && deletedCount>0**（对齐 issue-lifecycle-scheduler.ts:131）：
   * 删满 limit（=可能还有积压）且本轮真删了行 → 调度短延迟续删。deletedCount===0（本轮全 race /
   * 全 throw）不排避免空转死循环。单写者 SQLite 下 race 近不可能，parity + 防御保留。
   *
   * 失败兜底：listExpiredForGc / batchHardDelete throw（如 DB 锁）不崩 scheduler tick —— 整体
   * try/catch + scoped logger，下一 tick（6h 后或 catch-up）重试。
   */
  scan(): void {
    if (this.opts.messageRetentionDays <= 0) return;
    // impl-review claude INFO-1：clamp 到 GC_BATCH_LIMIT（= repo listExpiredForGc 内部 cap）。
    // caller 传 gcBatchLimit>cap 时 repo 最多返 cap 条，若 hitLimit 用未 clamp 的大值判定会永 false
    // → 有积压也不排 catch-up。clamp 后 hitLimit 阈值与 repo 实际返回上限一致，catch-up 正确触发。
    const limit = Math.min(this.opts.gcBatchLimit ?? DEFAULT_GC_BATCH_LIMIT, GC_BATCH_LIMIT);
    let deletedCount = 0;
    let hitLimit = false;
    let candidateCount = 0;
    try {
      const ids = agentDeckMessageRepo.listExpiredForGc({
        retentionDays: this.opts.messageRetentionDays,
        now: Date.now(),
        limit,
      });
      if (ids.length === 0) return;
      candidateCount = ids.length;
      hitLimit = ids.length >= limit;
      const removed = agentDeckMessageRepo.batchHardDelete(ids);
      deletedCount = removed.length;
    } catch (err) {
      logger.warn('[message-gc] scan failed', {
        retentionDays: this.opts.messageRetentionDays,
        limit,
      }, err);
      return;
    }
    if (deletedCount > 0) {
      eventBus.emit('agent-deck-message-purged', { count: deletedCount });
      logger.info('[message-gc] purged expired terminal messages', {
        deletedCount,
        candidateCount,
        retentionDays: this.opts.messageRetentionDays,
        limit,
        hitLimit,
      });
    }
    // 删满 limit + 真删了行 → 调度短延迟续删 tick（积压清完回常态 6h）。
    if (hitLimit && deletedCount > 0) {
      this.scheduleCatchUpTick();
    }
  }

  /**
   * 调度一个短延迟续删 tick（one-shot）。已有 pending catch-up 时不重复排（避免同一轮积压排多个
   * timer）。timer fire 时先清自身引用再 scan()，让本轮若仍删满可再排下一个。
   */
  private scheduleCatchUpTick(): void {
    if (this.catchUpTimer) return;
    const delay = this.opts.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.scan();
    }, delay);
  }
}

/**
 * 单例 hook — bootstrap 时通过 setMessageLifecycleScheduler 注册当前实例，
 * IPC 在用户改设置时通过 getMessageLifecycleScheduler 拿到引用并热更新阈值。
 * before-quit 通过 setMessageLifecycleScheduler(null) 清引用 + .stop() 防 timer 继续碰 DB。
 */
let activeScheduler: MessageLifecycleScheduler | null = null;

export function setMessageLifecycleScheduler(s: MessageLifecycleScheduler | null): void {
  activeScheduler = s;
}

export function getMessageLifecycleScheduler(): MessageLifecycleScheduler | null {
  return activeScheduler;
}
