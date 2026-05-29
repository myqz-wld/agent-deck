import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { applyClosedSideEffects } from '@main/session/manager-team-coordinator';
import log from '@main/utils/logger';

const logger = log.scope('lifecycle-scheduler');

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
    const updatedClosedIds = new Set<string>();
    const dormantRows = sessionRepo.findDormantExpiring(closedThreshold);
    if (dormantRows.length > 0) {
      const updated = sessionRepo.batchSetLifecycle(
        dormantRows.map((r) => r.id),
        'closed',
        now,
      );
      // REVIEW_56 Batch C R1 codex HIGH-1 + reviewer-claude 反驳轮验证修法(方案 B):
      // 补齐 sessionManager.markClosed 三入口副作用(`manager.ts:329-347` 注释:
      // "三入口 markClosed / close / archive 统一" 清 cwd_release_marker + "被动清理
      // closed session 自动 leave 所有 active team membership" — 两条 invariant 显式声明)。
      // 旧实现 scheduler 只调 batchSetLifecycle (只 UPDATE sessions.lifecycle/ended_at),
      // 是绕过两条 invariant 的"第四入口" → (1) UI 幽灵成员 user-visible(closed session
      // 仍 active member); (2) cwd_release_marker 残留 latent risk; (3) 0-lead
      // auto-archive 联动缺失。修法:保留 batch SQL 性能 + 对 updated rows 逐条补齐两个副作用
      // (leaveTeamsAndAutoArchive 与 markClosed L344 同款 fire-and-forget 不阻塞 scheduler
      // tick;clearCwdReleaseMarker 同步轻量 SQL 不会拖慢 tick)。
      //
      // REVIEW_56 Batch C R2 codex LOW-1 修法:scheduler emit 'session-upserted' 前,
      // sessionRepo.get(rec.id) re-fetch 拿 fresh record(含 cwd_release_marker=NULL),
      // 避免 renderer 收到 stale marker(batchSetLifecycle 内 SELECT 拿的 rec 在 clear
      // 之前;clear 后 emit 旧 rec → renderer store 仍带 stale marker 直到下次 upsert)。
      for (const rec of updated) {
        updatedClosedIds.add(rec.id);
        // REVIEW_56 §F20 修法 (Plan-Review Round 1 + spike 决策, DRY): 三入口 (markClosed / close /
        // lifecycle-scheduler purge) 副作用统一抽 applyClosedSideEffects helper。
        // 顺序: sync clearMarker (含 try/catch 错误隔离) → sync onClearedBeforeLeave callback
        // (refresh + emit upserted) → async fire-and-forget leave。详
        // manager-team-coordinator.ts §applyClosedSideEffects jsdoc。
        void applyClosedSideEffects(rec.id, {
          awaitLeave: false,
          logPrefix: '[lifecycle-scheduler]',
          onClearedBeforeLeave: () => {
            const refreshed = sessionRepo.get(rec.id) ?? rec;
            eventBus.emit('session-upserted', refreshed);
          },
        });
      }
    }

    // 3. 历史超期清理：lastEventAt 早于 (now - retention) 且属于历史面板范围
    //    （lifecycle = closed 或 archived_at IS NOT NULL）。
    //    每轮最多清 500 条，剩余的下轮继续。事件 / 文件改动 / 总结由外键 CASCADE 一并删除。
    //
    // REVIEW_56 Batch C R2 codex MED-1 修法(选项 b):排除本轮刚被 dormant→closed 的 ids
    // 避免「同 tick fire-and-forget leaveTeamsAndAutoArchive 让出 microtask + purge 抢先
    // batchDelete sessions → CASCADE 删 agent_deck_team_members → helper 恢复时 leave 空跑
    // → 0-lead auto-archive 漏触发 + agent-deck-team-member-changed 漏 emit」fix-to-fix
    // regression。触发条件:historyRetentionDays=1 + closeAfterMs=24h 阈值重合(典型默认配置 —
    // 同 last_event_at < now - 24h 既符合 dormant→closed 又符合 purge 阈值)。
    // 修法选项(b)最低侵入:本轮 purge 排除 updatedClosedIds,刚 closed 的 rows 等下一 tick
    // (默认 60s 后)再考虑 purge — 给 leaveTeamsAndAutoArchive 充分时间 await import + 跑完整
    // leave + auto-archive 链。
    if (this.opts.historyRetentionDays > 0) {
      const retentionMs = this.opts.historyRetentionDays * 24 * 60 * 60 * 1000;
      const purgeThreshold = now - retentionMs;
      const ids = sessionRepo.findHistoryOlderThan(purgeThreshold);
      const idsToPurge =
        updatedClosedIds.size > 0 ? ids.filter((id) => !updatedClosedIds.has(id)) : ids;
      if (idsToPurge.length > 0) {
        const removed = sessionRepo.batchDelete(idsToPurge);
        for (const id of removed) eventBus.emit('session-removed', id);
        logger.info(
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
