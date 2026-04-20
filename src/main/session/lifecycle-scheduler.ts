import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from './manager';

interface SchedulerOptions {
  /** 多久没事件就推到 dormant，毫秒 */
  activeWindowMs: number;
  /** dormant 状态多久没事件就推到 closed，毫秒 */
  closeAfterMs: number;
  /** 调度间隔，毫秒；默认 60s */
  intervalMs?: number;
}

/**
 * 周期性扫描 sessions 表，按时间阈值推进 active → dormant → closed。
 *
 * 注意：阈值用 `last_event_at` 与当前时间对比；`closeAfterMs` 是相对当前时间，
 * 而不是 dormant 进入时间，这样实现简单且符合直觉
 * （「24h 没动静就关掉」）。
 */
export class LifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private opts: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    const tick = (): void => this.scan();
    tick();
    this.timer = setInterval(tick, this.opts.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateThresholds(opts: Partial<SchedulerOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  scan(): void {
    const now = Date.now();
    const dormantThreshold = now - this.opts.activeWindowMs;
    const closedThreshold = now - this.opts.closeAfterMs;

    const toDormant = sessionRepo.findActiveExpiring(dormantThreshold);
    for (const s of toDormant) {
      sessionManager.markDormant(s.id);
    }
    const toClosed = sessionRepo.findDormantExpiring(closedThreshold);
    for (const s of toClosed) {
      sessionManager.markClosed(s.id);
    }
  }
}

/**
 * 单例 hook：bootstrap 时通过 setLifecycleScheduler 注册当前实例，
 * IPC 在用户改设置时通过 getLifecycleScheduler 拿到引用并热更新阈值。
 */
let activeScheduler: LifecycleScheduler | null = null;

export function setLifecycleScheduler(s: LifecycleScheduler | null): void {
  activeScheduler = s;
}

export function getLifecycleScheduler(): LifecycleScheduler | null {
  return activeScheduler;
}
