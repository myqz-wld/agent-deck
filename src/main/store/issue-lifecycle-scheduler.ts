/**
 * Periodically removes expired resolved or soft-deleted issues.
 *
 * Parent deletion cascades appendices. Each successful deletion emits the
 * existing issue-changed event with the pre-delete source-session snapshot.
 */

import { issueRepo } from '@main/store/issue-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const logger = log.scope('issue-gc');

interface IssueSchedulerOptions {
  resolvedRetentionDays: number;
  softDeletedRetentionDays: number;
  tickIntervalMs?: number;
  gcBatchLimit?: number;
  catchUpDelayMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 6 * 3600_000;
const DEFAULT_GC_BATCH_LIMIT = 500;
const DEFAULT_CATCH_UP_DELAY_MS = 30_000;

export class IssueLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
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
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
  }

  updateThresholds(opts: Partial<IssueSchedulerOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Scan one bounded batch per retention path. */
  scan(): void {
    const startedAt = performance.now();
    try {
      this.scanOnce(startedAt);
    } catch {
      logger.warn('Issue retention scan failed', {
        action: 'issue-retention',
        phase: 'scan',
        candidate: 0,
        changed: 0,
        duration: Math.round(performance.now() - startedAt),
        outcome: 'failed',
      });
    }
  }

  private scanOnce(startedAt: number): void {
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
        const snapshot = issueRepo.get(id);
        const ok = issueRepo.hardDelete(id);
        if (!ok) continue;
        eventBus.emit('issue-changed', {
          kind: 'hardDeleted',
          issueId: id,
          issue: null,
          sourceSessionId: snapshot?.sourceSessionId ?? null,
          ts: Date.now(),
        });
        deletedCount++;
      } catch {
        logger.warn('Issue retention candidate failed', {
          action: 'issue-retention',
          phase: 'delete',
          candidate: 1,
          changed: 0,
          duration: Math.round(performance.now() - startedAt),
          outcome: 'failed',
        });
      }
    }
    const hitLimit =
      result.resolvedExpired.length >= limit || result.softDeletedExpired.length >= limit;
    if (deletedCount > 0) {
      logger.info('Issue retention batch completed', {
        action: 'issue-retention',
        phase: 'delete',
        candidate: allIds.length,
        changed: deletedCount,
        duration: Math.round(performance.now() - startedAt),
        outcome: 'success',
      });
    }
    if (hitLimit && deletedCount > 0) {
      this.scheduleCatchUpTick();
    }
  }

  private scheduleCatchUpTick(): void {
    if (this.catchUpTimer) return;
    const delay = this.opts.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.scan();
    }, delay);
  }
}

let activeScheduler: IssueLifecycleScheduler | null = null;

export function setIssueLifecycleScheduler(s: IssueLifecycleScheduler | null): void {
  activeScheduler = s;
}

export function getIssueLifecycleScheduler(): IssueLifecycleScheduler | null {
  return activeScheduler;
}
