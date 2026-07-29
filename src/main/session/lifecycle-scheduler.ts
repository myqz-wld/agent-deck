import { sessionRepo } from '@main/store/session-repo';
import {
  LIFECYCLE_BATCH_SIZE,
  type HistoryLifecycleCursor,
} from '@main/store/session-repo/lifecycle';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { disposeSessionBrowser } from '@main/browser-use/session-browser';
import log from '@main/utils/logger';

const logger = log.scope('lifecycle-scheduler');
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CATCH_UP_DELAY_MS = 1_000;
const SLOW_BATCH_MS = 50;

interface SchedulerOptions {
  activeWindowMs: number;
  closeAfterMs: number;
  historyRetentionDays: number;
  intervalMs?: number;
  catchUpDelayMs?: number;
}

interface PhaseResult {
  needsCatchUp: boolean;
}

interface HistoryPhaseResult extends PhaseResult {
  cursor: HistoryLifecycleCursor | null;
}

interface PhaseLog {
  phase: 'active-to-dormant' | 'dormant-to-closed' | 'history-purge' | 'tick';
  candidate: number;
  changed: number;
  skippedLive: number;
  duration: number;
  outcome: 'changed' | 'unchanged' | 'error';
}

function logPhase(result: PhaseLog): void {
  if (result.outcome === 'error') {
    logger.warn('lifecycle phase failed', result);
  } else if (result.changed > 0 || result.duration >= SLOW_BATCH_MS) {
    logger.info('lifecycle phase completed', result);
  }
}

export class LifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  private catchUpTimer: NodeJS.Timeout | null = null;

  constructor(private opts: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
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

  updateThresholds(opts: Partial<SchedulerOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  scan(): void {
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.runTickSafely(null);
  }

  private runTickSafely(historyCursor: HistoryLifecycleCursor | null): void {
    const startedAt = Date.now();
    try {
      const now = Date.now();
      const updatedClosedIds = new Set<string>();
      const active = this.runActivePhase(now);
      const dormant = this.runDormantPhase(now, updatedClosedIds);
      const history = this.runHistoryPhase(now, historyCursor, updatedClosedIds);
      if (active.needsCatchUp || dormant.needsCatchUp || history.needsCatchUp) {
        this.scheduleCatchUp(history.needsCatchUp ? history.cursor : null);
      }
    } catch {
      logPhase({
        phase: 'tick',
        candidate: 0,
        changed: 0,
        skippedLive: 0,
        duration: Date.now() - startedAt,
        outcome: 'error',
      });
    }
  }

  private runActivePhase(now: number): PhaseResult {
    const startedAt = Date.now();
    let candidate = 0;
    let changed = 0;
    try {
      const threshold = now - this.opts.activeWindowMs;
      const rows = sessionRepo.findActiveExpiring(threshold, LIFECYCLE_BATCH_SIZE);
      candidate = rows.length;
      if (candidate > 0) {
        const updated = sessionRepo.batchAdvanceLifecycle(
          rows.map((row) => row.id),
          'active',
          'dormant',
          now,
          threshold,
        );
        changed = updated.length;
        for (const record of updated) eventBus.emit('session-upserted', record);
      }
      logPhase({
        phase: 'active-to-dormant',
        candidate,
        changed,
        skippedLive: 0,
        duration: Date.now() - startedAt,
        outcome: changed > 0 ? 'changed' : 'unchanged',
      });
      return {
        needsCatchUp: candidate >= LIFECYCLE_BATCH_SIZE && changed > 0,
      };
    } catch {
      logPhase({
        phase: 'active-to-dormant',
        candidate,
        changed,
        skippedLive: 0,
        duration: Date.now() - startedAt,
        outcome: 'error',
      });
      return { needsCatchUp: false };
    }
  }

  private runDormantPhase(now: number, updatedClosedIds: Set<string>): PhaseResult {
    const startedAt = Date.now();
    let candidate = 0;
    let changed = 0;
    let sideEffectFailed = false;
    try {
      const threshold = now - this.opts.closeAfterMs;
      const rows = sessionRepo.findDormantExpiring(threshold, LIFECYCLE_BATCH_SIZE);
      candidate = rows.length;
      if (candidate > 0) {
        const updated = sessionRepo.batchAdvanceLifecycle(
          rows.map((row) => row.id),
          'dormant',
          'closed',
          now,
          threshold,
        );
        changed = updated.length;
        for (const record of updated) {
          updatedClosedIds.add(record.id);
          try {
            sessionManager.bumpCloseEpoch(record.id);
          } catch {
            sideEffectFailed = true;
          }
          void disposeSessionBrowser(record.id).catch(() => {
            // The browser disposer owns its detailed error log.
          });
          try {
            void sessionManager.runClosedSideEffects(record.id, {
              onClearedBeforeLeave: () => {
                eventBus.emit('session-upserted', sessionRepo.get(record.id) ?? record);
              },
            }).catch(() => {
              // The close-side-effect coordinator owns its detailed error log.
            });
          } catch {
            sideEffectFailed = true;
          }
        }
      }
      logPhase({
        phase: 'dormant-to-closed',
        candidate,
        changed,
        skippedLive: 0,
        duration: Date.now() - startedAt,
        outcome: sideEffectFailed ? 'error' : changed > 0 ? 'changed' : 'unchanged',
      });
      return {
        needsCatchUp: candidate >= LIFECYCLE_BATCH_SIZE && changed > 0,
      };
    } catch {
      logPhase({
        phase: 'dormant-to-closed',
        candidate,
        changed,
        skippedLive: 0,
        duration: Date.now() - startedAt,
        outcome: 'error',
      });
      return { needsCatchUp: false };
    }
  }

  private runHistoryPhase(
    now: number,
    cursor: HistoryLifecycleCursor | null,
    updatedClosedIds: ReadonlySet<string>,
  ): HistoryPhaseResult {
    if (this.opts.historyRetentionDays <= 0) {
      return { needsCatchUp: false, cursor: null };
    }
    const startedAt = Date.now();
    let candidate = 0;
    let changed = 0;
    let skippedLive = 0;
    try {
      const retentionMs = this.opts.historyRetentionDays * 24 * 60 * 60 * 1000;
      const threshold = now - retentionMs;
      const rows = sessionRepo.findHistoryOlderThan(
        threshold,
        cursor,
        LIFECYCLE_BATCH_SIZE,
      );
      candidate = rows.length;
      const nextCursor = rows.length > 0
        ? { lastEventAt: rows.at(-1)!.lastEventAt, id: rows.at(-1)!.id }
        : cursor;
      const deletable = rows.filter((row) => {
        const live =
          updatedClosedIds.has(row.id) ||
          sessionManager.hasPendingCloseSideEffects(row.id) ||
          sessionManager.hasSdkClaim(row.id) ||
          (row.cliSessionId != null && sessionManager.hasSdkClaim(row.cliSessionId));
        if (live) skippedLive += 1;
        return !live;
      });
      const removed = deletable.length > 0
        ? sessionRepo.batchDeleteHistory(deletable, threshold)
        : [];
      changed = removed.length;
      let cleanupFailed = false;

      // Fence every removed identity before starting any asynchronous cleanup.
      for (const row of removed) {
        sessionManager.markRecentlyDeleted(row.id, row.cliSessionId);
      }
      for (const row of removed) {
        void disposeSessionBrowser(row.id).catch(() => {
          // The browser disposer owns its detailed error log.
        });
        try {
          sessionManager.forgetCloseEpoch(row.id);
        } catch {
          cleanupFailed = true;
        }
        try {
          eventBus.emit('session-removed', row.id);
        } catch {
          cleanupFailed = true;
        }
      }

      const cursorMoved =
        nextCursor != null &&
        (cursor == null ||
          nextCursor.lastEventAt !== cursor.lastEventAt ||
          nextCursor.id !== cursor.id);
      logPhase({
        phase: 'history-purge',
        candidate,
        changed,
        skippedLive,
        duration: Date.now() - startedAt,
        outcome: cleanupFailed ? 'error' : changed > 0 ? 'changed' : 'unchanged',
      });
      return {
        needsCatchUp:
          candidate >= LIFECYCLE_BATCH_SIZE && (changed > 0 || cursorMoved),
        cursor: nextCursor,
      };
    } catch {
      logPhase({
        phase: 'history-purge',
        candidate,
        changed,
        skippedLive,
        duration: Date.now() - startedAt,
        outcome: 'error',
      });
      return { needsCatchUp: false, cursor };
    }
  }

  private scheduleCatchUp(cursor: HistoryLifecycleCursor | null): void {
    if (this.catchUpTimer) return;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.runTickSafely(cursor);
    }, this.opts.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS);
  }
}

let activeScheduler: LifecycleScheduler | null = null;

export function setLifecycleScheduler(s: LifecycleScheduler | null): void {
  activeScheduler = s;
}

export function getLifecycleScheduler(): LifecycleScheduler | null {
  return activeScheduler;
}
