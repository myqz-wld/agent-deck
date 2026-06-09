/**
 * IssueLifecycleScheduler — 周期性扫描 issues 表，按 §D13 阈值硬删超期 issue。
 *
 * 与 src/main/session/lifecycle-scheduler.ts 同款 `setInterval(tick, intervalMs)` pattern。
 *
 * **§D20**: `tickIntervalMs` 默认 6h（不与 LifecycleScheduler 60s tick 同频 — retention 单位是 day,
 * GC 漂移几小时无害）。
 *
 * **§D7 / §D15 边界**: 仅 hardDelete `status='resolved' && resolved_at < now - days`（**不**触发
 * resolved → 其他 status 的 transition — 直接 DELETE）+ `deleted_at < now - days` 的软删 issue。
 * 阈值 = 0 时跳过该路径 GC。
 *
 * **§不变量 2 / §D11**: issue_appendices 子表 ON DELETE CASCADE 自动级联删,无需 scheduler 额外处理。
 *
 * **issue-changed 事件**: 每次 hardDelete **逐条** emit `kind='hardDeleted' issue: null sourceSessionId:
 * <snapshot.sourceSessionId> ts`（snapshot 删前从 issueRepo.get 拿）让 renderer issues-store 精细
 * invalidate（与 TaskChangedEvent.ownerSessionId 顶级字段对称 — §D7 R3 LOW F7）。
 */

import { issueRepo } from '@main/store/issue-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const logger = log.scope('issue-gc');

interface IssueSchedulerOptions {
  /** §D13 阈值: status='resolved' && resolved_at < now - days * 86400_000 → hardDelete。0 = 关闭 */
  resolvedRetentionDays: number;
  /** §D13 阈值: deleted_at < now - days * 86400_000 → hardDelete。0 = 关闭 */
  softDeletedRetentionDays: number;
  /** 调度间隔；默认 6h（D20） */
  tickIntervalMs?: number;
  /**
   * Follow-up #11: GC 单轮批量上限,传给 listForGc(每路) + 判定本轮是否删满(=还有积压)。
   * 默认 500(与 issue-repo listForGc 内部 default + session-repo findHistoryOlderThan 对称)。
   */
  gcBatchLimit?: number;
  /**
   * Follow-up #11: 某路删满 limit(还有积压)时调度的「续删 tick」短延迟。默认 30s。
   * 常态 6h tick 不变,仅积压未清完时用此短延迟加速续删直到某轮删 < limit。
   */
  catchUpDelayMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 6 * 3600_000;
const DEFAULT_GC_BATCH_LIMIT = 500;
const DEFAULT_CATCH_UP_DELAY_MS = 30_000;

export class IssueLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** Follow-up #11: 积压续删 one-shot timer(与常态 setInterval timer 独立);stop() 一并清。 */
  private catchUpTimer: NodeJS.Timeout | null = null;
  constructor(private opts: IssueSchedulerOptions) {}

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
    // Follow-up #11: 一并清 pending 续删 timer,防 stop 后 catch-up tick 仍碰 DB。
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
  }

  updateThresholds(opts: Partial<IssueSchedulerOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /**
   * §D13 GC tick: listForGc 拿超期 id → 逐条 snapshot 删前 + hardDelete + emit。
   *
   * **逐条 emit 而非批量 emit**: 与 task-delete-handler:65-73 pattern 一致。renderer issues-store
   * 按单条 event 精细 invalidate;减少 batch 处理写时 cache miss 风险。
   *
   * **snapshot before delete**: hardDelete 之后 issueRepo.get 返 null,sourceSessionId 失去依据 —
   * 提前 snapshot 拿 sourceSessionId 顶级字段（issue: null 但 sourceSessionId 仍是删前 issue.sourceSessionId）。
   *
   * **每路单轮上限 500**（REVIEW_83 LOW，reviewer-codex E2 + lead）: listForGc 默认 limit=500
   * （与 session-repo findHistoryOlderThan 对称），剩余下轮 tick 续，防 retention 0→非 0 首次启用
   * 或 high-volume 批量过期时一次同步删上万行 + 上万次 emit 卡主线程（scan() 是 sync 逐条）。
   *
   * 失败兜底: 单条 hardDelete throw 不中断后续 — 每条独立 try/catch + scoped logger,scheduler
   * tick 不因单条 corrupt row 整批崩。
   *
   * **Follow-up #11 续删节奏**: 某路 listForGc 删满 limit(=可能还有积压)→ 调度一个短延迟
   * (catchUpDelayMs 默认 30s)的额外 tick 续删,直到某轮两路都删 < limit。常态 6h tick 频率
   * 不变,只在「积压未清完」时加速续删。用户调短 retention 想快速清积压时不必等 6h × N 轮。
   * one-shot timer(catchUpTimer),复用同 scan() — 重入时若已有 pending catch-up 不重复排。
   */
  scan(): void {
    const limit = this.opts.gcBatchLimit ?? DEFAULT_GC_BATCH_LIMIT;
    const result = issueRepo.listForGc({
      resolvedRetentionDays: this.opts.resolvedRetentionDays,
      softDeletedRetentionDays: this.opts.softDeletedRetentionDays,
      limit,
    });
    const allIds = [...result.resolvedExpired, ...result.softDeletedExpired];
    if (allIds.length === 0) return;
    let deletedCount = 0;
    for (const id of allIds) {
      try {
        // snapshot before delete — sourceSessionId 用于事件载体让 renderer 精细 invalidate
        const snapshot = issueRepo.get(id);
        const ok = issueRepo.hardDelete(id);
        if (!ok) continue; // race: 已被另一处删
        eventBus.emit('issue-changed', {
          kind: 'hardDeleted',
          issueId: id,
          issue: null,
          sourceSessionId: snapshot?.sourceSessionId ?? null,
          ts: Date.now(),
        });
        deletedCount++;
      } catch (err) {
        logger.warn('[issue-gc] hardDelete failed', { issueId: id }, err);
      }
    }
    // Follow-up #11: 某路删满 limit = 可能还有积压 → 调度短延迟续删 tick。两路都 < limit 时不排
    // (积压清完,回到常态 6h tick)。deletedCount === 0(本轮全 race / 全 throw)也不排避免空转死循环。
    const hitLimit =
      result.resolvedExpired.length >= limit || result.softDeletedExpired.length >= limit;
    if (deletedCount > 0) {
      logger.info('[issue-gc] hardDeleted issues', {
        deletedCount,
        resolvedExpired: result.resolvedExpired.length,
        softDeletedExpired: result.softDeletedExpired.length,
        limit,
        hitLimit,
      });
    }
    if (hitLimit && deletedCount > 0) {
      this.scheduleCatchUpTick();
    }
  }

  /**
   * Follow-up #11: 调度一个短延迟续删 tick(one-shot)。已有 pending catch-up 时不重复排
   * (避免同一轮积压排多个 timer)。timer fire 时先清自身引用再 scan(),让本轮若仍删满可再排下一个。
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
 * 单例 hook — bootstrap 时通过 setIssueLifecycleScheduler 注册当前实例,
 * IPC 在用户改设置时通过 getIssueLifecycleScheduler 拿到引用并热更新阈值。
 * before-quit 通过 setIssueLifecycleScheduler(null) 清引用 + .stop() 防 timer 继续碰 DB。
 */
let activeScheduler: IssueLifecycleScheduler | null = null;

export function setIssueLifecycleScheduler(s: IssueLifecycleScheduler | null): void {
  activeScheduler = s;
}

export function getIssueLifecycleScheduler(): IssueLifecycleScheduler | null {
  return activeScheduler;
}
