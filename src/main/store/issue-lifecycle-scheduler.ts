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

interface IssueSchedulerOptions {
  /** §D13 阈值: status='resolved' && resolved_at < now - days * 86400_000 → hardDelete。0 = 关闭 */
  resolvedRetentionDays: number;
  /** §D13 阈值: deleted_at < now - days * 86400_000 → hardDelete。0 = 关闭 */
  softDeletedRetentionDays: number;
  /** 调度间隔；默认 6h（D20） */
  tickIntervalMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 6 * 3600_000;

export class IssueLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
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
   * 失败兜底: 单条 hardDelete throw 不中断后续 — 每条独立 try/catch + console.warn,scheduler
   * tick 不因单条 corrupt row 整批崩。
   */
  scan(): void {
    const result = issueRepo.listForGc({
      resolvedRetentionDays: this.opts.resolvedRetentionDays,
      softDeletedRetentionDays: this.opts.softDeletedRetentionDays,
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
        console.warn(`[issue-gc] hardDelete ${id} failed:`, err);
      }
    }
    if (deletedCount > 0) {
      console.log(`[issue-gc] hardDeleted ${deletedCount} issues (resolved=${result.resolvedExpired.length}, soft=${result.softDeletedExpired.length})`);
    }
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
