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

const logger = log.scope('token-usage-gc');

/** Keep one year of token history; this is not user-configurable by design. */
export const TOKEN_USAGE_RETENTION_DAYS = 365;
const DEFAULT_TICK_INTERVAL_MS = 6 * 3600_000;

interface TokenUsageLifecycleSchedulerOptions {
  /** Test hook only. Production uses the fixed TOKEN_USAGE_RETENTION_DAYS. */
  tickIntervalMs?: number;
}

export class TokenUsageLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;

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
  }

  /**
   * Delete rows older than TOKEN_USAGE_RETENTION_DAYS. This is a single SQL
   * delete because token_usage has no per-row lifecycle/status that needs
   * side effects, and the table already has an index on ts.
   */
  scan(): void {
    const now = Date.now();
    const thresholdMs = now - TOKEN_USAGE_RETENTION_DAYS * 86_400_000;
    let deletedCount = 0;
    try {
      deletedCount = tokenUsageRepo.deleteOlderThan(thresholdMs);
    } catch (err) {
      logger.warn('[token-usage-gc] scan failed', {
        retentionDays: TOKEN_USAGE_RETENTION_DAYS,
        thresholdMs,
      }, err);
      return;
    }

    if (deletedCount > 0) {
      eventBus.emit('token-usage-changed', { sessionId: 'gc', ts: now });
      logger.info('[token-usage-gc] purged expired token_usage rows', {
        deletedCount,
        retentionDays: TOKEN_USAGE_RETENTION_DAYS,
      });
    }
  }
}

let activeScheduler: TokenUsageLifecycleScheduler | null = null;

export function setTokenUsageLifecycleScheduler(s: TokenUsageLifecycleScheduler | null): void {
  activeScheduler = s;
}

export function getTokenUsageLifecycleScheduler(): TokenUsageLifecycleScheduler | null {
  return activeScheduler;
}
