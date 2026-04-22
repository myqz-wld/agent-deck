import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';

interface SchedulerOptions {
  /** 多久没事件就推到 dormant，毫秒 */
  activeWindowMs: number;
  /** dormant 状态多久没事件就推到 closed，毫秒 */
  closeAfterMs: number;
  /** 历史会话保留天数；0 = 不清理。基于 last_event_at 与当前时间比较。 */
  historyRetentionDays: number;
  /** 调度间隔，毫秒；默认 60s */
  intervalMs?: number;
}

/**
 * 周期性扫描 sessions 表，按时间阈值推进 active → dormant → closed，
 * 并在 historyRetentionDays > 0 时清理超期的历史会话（closed 或归档）。
 *
 * 注意：阈值用 `last_event_at` 与当前时间对比；`closeAfterMs` 是相对当前时间，
 * 而不是 dormant 进入时间，这样实现简单且符合直觉
 * （「24h 没动静就关掉」）。
 *
 * 性能：早期版本每个会话跑「get → setLifecycle → get → emit」共 3 次 SQL，
 * better-sqlite3 同步执行 → 主线程被卡。现在改成 batchSetLifecycle 单事务批量推进，
 * 事务内一次 UPDATE + SELECT 拿真正变化的行后批量 emit，避免 N+1 SQL。
 *
 * 历史清理：findHistoryOlderThan 单次最多取 500 条，剩余下轮继续，避免一次扫描
 * 删上万行卡死主线程；归档与否都参与（只要落入历史面板范围就可清）。
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

    // 1. active → dormant：先拿候选 id，再单事务批量推进
    const activeRows = sessionRepo.findActiveExpiring(dormantThreshold);
    if (activeRows.length > 0) {
      const updated = sessionRepo.batchSetLifecycle(
        activeRows.map((r) => r.id),
        'dormant',
        now,
      );
      for (const rec of updated) eventBus.emit('session-upserted', rec);
    }

    // 2. dormant → closed
    const dormantRows = sessionRepo.findDormantExpiring(closedThreshold);
    if (dormantRows.length > 0) {
      const updated = sessionRepo.batchSetLifecycle(
        dormantRows.map((r) => r.id),
        'closed',
        now,
      );
      for (const rec of updated) eventBus.emit('session-upserted', rec);
    }

    // 3. 历史超期清理：lastEventAt 早于 (now - retention) 且属于历史面板范围
    //    （lifecycle = closed 或 archived_at IS NOT NULL）。
    //    每轮最多清 500 条，剩余的下轮继续。事件 / 文件改动 / 总结由外键 CASCADE 一并删除。
    if (this.opts.historyRetentionDays > 0) {
      const retentionMs = this.opts.historyRetentionDays * 24 * 60 * 60 * 1000;
      const purgeThreshold = now - retentionMs;
      const ids = sessionRepo.findHistoryOlderThan(purgeThreshold);
      if (ids.length > 0) {
        const removed = sessionRepo.batchDelete(ids);
        for (const id of removed) eventBus.emit('session-removed', id);
        console.log(
          `[lifecycle] purged ${removed.length} history sessions older than ${this.opts.historyRetentionDays}d`,
        );
      }
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
