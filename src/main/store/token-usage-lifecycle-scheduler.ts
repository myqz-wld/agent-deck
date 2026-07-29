/**
 * TokenUsageLifecycleScheduler — fixed-retention GC for token_usage rows.
 *
 * token_usage is the historical source for daily token statistics, so it uses a
 * wider fixed retention than session/message GC and is intentionally not exposed
 * as a user-facing setting.
 */
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';
import { tokenUsageRepo } from './token-usage-repo';
import { TOKEN_USAGE_GC_BATCH_LIMIT } from './token-usage-retention';

const logger = log.scope('token-usage-gc');

/** Keep one year of token history; this is not user-configurable by design. */
export const TOKEN_USAGE_RETENTION_DAYS = 365;
export { TOKEN_USAGE_GC_BATCH_LIMIT };
const DEFAULT_TICK_INTERVAL_MS = 6 * 3600_000;
const DEFAULT_CATCH_UP_DELAY_MS = 30_000;

interface TokenUsageLifecycleSchedulerOptions {
  tickIntervalMs?: number;
  catchUpDelayMs?: number;
}

export class TokenUsageLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  private catchUpTimer: NodeJS.Timeout | null = null;
  private scanInProgress = false;

  constructor(private opts: TokenUsageLifecycleSchedulerOptions = {}) {}

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
    this.clearCatchUp();
  }

  /** Delete one bounded batch and continue one-shot batches while each remains full. */
  scan(): void {
    if (this.catchUpTimer) return;
    this.runBatch('scheduled');
  }

  private runBatch(phase: 'scheduled' | 'catch-up'): void {
    if (this.scanInProgress) return;
    this.scanInProgress = true;
    const startedAt = performance.now();
    try {
      const now = Date.now();
      const thresholdMs = now - TOKEN_USAGE_RETENTION_DAYS * 86_400_000;
      const deletedCount = tokenUsageRepo.deleteOlderThan(thresholdMs);
      if (deletedCount > 0) {
        eventBus.emit('token-usage-changed', { sessionId: 'gc', ts: now });
        logger.info('Token usage retention batch completed', {
          action: 'token-usage-retention',
          phase,
          candidate: TOKEN_USAGE_GC_BATCH_LIMIT,
          changed: deletedCount,
          duration: Math.round(performance.now() - startedAt),
          outcome: 'success',
        });
      }
      if (deletedCount === TOKEN_USAGE_GC_BATCH_LIMIT) {
        this.scheduleCatchUp();
      } else {
        this.clearCatchUp();
      }
    } catch {
      this.clearCatchUp();
      logger.warn('Token usage retention batch failed', {
        action: 'token-usage-retention',
        phase,
        candidate: TOKEN_USAGE_GC_BATCH_LIMIT,
        changed: 0,
        duration: Math.round(performance.now() - startedAt),
        outcome: 'failed',
      });
    } finally {
      this.scanInProgress = false;
    }
  }

  private scheduleCatchUp(): void {
    if (this.catchUpTimer) return;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.runBatch('catch-up');
    }, this.opts.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS);
  }

  private clearCatchUp(): void {
    if (!this.catchUpTimer) return;
    clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
  }
}

let activeScheduler: TokenUsageLifecycleScheduler | null = null;

export function setTokenUsageLifecycleScheduler(s: TokenUsageLifecycleScheduler | null): void {
  activeScheduler = s;
}

export function getTokenUsageLifecycleScheduler(): TokenUsageLifecycleScheduler | null {
  return activeScheduler;
}
