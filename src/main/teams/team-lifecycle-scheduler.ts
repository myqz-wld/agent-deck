/**
 * plan team-cohesion-fix-20260513 Phase F D7：team 生命周期 scheduler。
 *
 * 周期性扫描所有 active team（archived_at IS NULL）→ 检查每个 team 的 active member
 * （left_at IS NULL）→ 若所有 active member 对应的 session 都 lifecycle ∈ {'closed'} 且
 * 距最早 lifecycle 切 closed 的时间 ≥ grace period → 自动 archive 此 team
 * （emit `agent-deck-team-updated` 让 TeamHub UI 刷新）。
 *
 * 与 sessionManager._leaveAllActiveTeams（D6）的关系：
 * - D6 是「session 终止时主动调」的入口路径（close / markClosed / delete），lead 离开
 *   后立即触发 0-lead 自动 archive，这是**主路径**
 * - D7 scheduler 是**兜底路径**：lead 没经过 D6 入口（程序 ungraceful 退出 / hook
 *   绕过 sessionManager 的 fs 写直接 setLifecycle / 历史遗留数据），定期扫描清空
 *   长时间无活跃成员的「幽灵 team」
 *
 * grace period：避免误归档「teammate 短暂 closed 但马上 reactivate」场景。默认 30 分钟，
 * 与 LifecycleScheduler 的 dormant→closed 自然衰减时间数量级匹配。
 *
 * 与 LifecycleScheduler 区别：
 * - LifecycleScheduler 管 sessions 表（active → dormant → closed）
 * - TeamLifecycleScheduler 管 agent_deck_teams 表（active → archived）
 * - 两者独立运行；session 推到 closed 后下次 team scan 才看到 → 自动归档
 */

import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const logger = log.scope('team-lifecycle-scheduler');

interface SchedulerOptions {
  /** 扫描间隔，毫秒；默认 5 分钟 */
  intervalMs?: number;
  /**
   * grace period（毫秒）：active member 全 closed 后等多久才允许 archive。
   * 默认 30 分钟，与「短暂 reactivate」场景匹配。
   */
  graceMs?: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_GRACE_MS = 30 * 60_000;

export class TeamLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private graceMs: number;

  constructor(opts: SchedulerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      try {
        this.scan();
      } catch (err) {
        logger.warn('[team-lifecycle-scheduler] scan threw:', err);
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 单次扫描：拉所有 active team → 对每个 team 判定是否「幽灵」→ archive。
   *
   * 复杂度：O(activeTeams * activeMembers/team)，sessionRepo.get 是 indexed lookup
   * 所以单次扫描成本与 team 数量线性相关。生产环境 team 数 ≤ 100 量级，单次扫描应
   * 在 < 50ms。如未来 team 数爆炸再考虑批量 IN query。
   *
   * E 修（plan mcp-bug-and-feature-batch-20260513 Phase 2 Step 2.2）：改 while-loop
   * pagination。修前 `list({ activeOnly: true, limit: 200 })` 单次只扫前 200 条 active team，
   * 长期使用后超出 200 的 team 永远不被扫到 → 永远不 archive 即使是 ghost。
   * 修后分页扫完所有 active team；list signature 已支持 offset（team-crud.ts:138-141）。
   *
   * REVIEW_33 H4 修：两阶段（先收集后批量 archive）。修前边迭代边调 `_archiveTeam`，
   * `_archiveTeam` 把 `archived_at` 从 NULL 改非 NULL → 下次 `list({ activeOnly: true,
   * limit: PAGE_SIZE, offset })` active list 立即缩 N 条 → `offset += PAGE_SIZE` 跳过
   * N 条 ghost team。两 reviewer 双方独立提出（reviewer-claude node 模拟 500 条全
   * ghost 实测漏扫 200，30% 概率漏 22）。修后:
   *   1. first pass: 只 collect 满足 archive 条件的 teamId 列表（不调 _archiveTeam）
   *   2. second pass: 循环候选 list 调 _archiveTeam 批量收尾
   * 第一阶段全程不动 archived_at，pagination 稳定。
   */
  scan(): void {
    const now = Date.now();
    const PAGE_SIZE = 200;

    // first pass: 只收集候选 teamId + 触发 reason，不调 _archiveTeam
    const candidates: Array<{ teamId: string; reason: string }> = [];
    let offset = 0;
    while (true) {
      const batch = agentDeckTeamRepo.list({ activeOnly: true, limit: PAGE_SIZE, offset });
      for (const team of batch) {
        const members = agentDeckTeamRepo.listActiveMembers(team.id);
        if (members.length === 0) {
          // 没 active member 的 team 也要过 grace 再 archive。spawn_session 先 ensure team，
          // 再 create session，最后 add members；这之间存在短暂空 team 初始化窗口。
          if (now - team.createdAt < this.graceMs) continue;
          candidates.push({ teamId: team.id, reason: 'no-active-members-grace-elapsed' });
          continue;
        }
        // 检查所有 active member 对应的 session 是否都 closed
        let allClosed = true;
        let latestClosedAt = 0;
        for (const m of members) {
          const sess = sessionRepo.get(m.sessionId);
          if (!sess || sess.lifecycle !== 'closed') {
            allClosed = false;
            break;
          }
          // 取最近一次 close 时间作为「team 全员 closed」的时刻
          if (sess.lastEventAt > latestClosedAt) latestClosedAt = sess.lastEventAt;
        }
        if (!allClosed) continue;
        // grace period：从「最近一次 close」开始算
        if (now - latestClosedAt < this.graceMs) continue;
        candidates.push({ teamId: team.id, reason: 'all-members-closed-grace-elapsed' });
      }
      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    // second pass: 批量 archive 所有候选
    for (const { teamId, reason } of candidates) {
      this._archiveTeam(teamId, reason);
    }
  }

  private _archiveTeam(teamId: string, detail: string): void {
    // REVIEW_32 MED-7：scheduler 路径统一记 'scheduler'；详细原因 detail 走 console.log（不进 DB），
    // unarchive 联动靠 archive_reason='last-lead-archived' 区分，scheduler 归档应保持归档（用户手工恢复）。
    const team = agentDeckTeamRepo.archive(teamId, { reason: 'scheduler' });
    if (team) {
      eventBus.emit('agent-deck-team-updated', team);
      logger.info(`[team-lifecycle-scheduler] archived team ${teamId} (${team.name}) — ${detail}`);
    }
  }
}

// 单例 facade — 与 LifecycleScheduler 同款 setX/getX 模式（避免 ipc.ts import 实例时
// 循环依赖 / 时序问题，详项目 CLAUDE.md「主进程模块通信 / IPC 边界」节）。
let _instance: TeamLifecycleScheduler | null = null;

export function setTeamLifecycleScheduler(scheduler: TeamLifecycleScheduler | null): void {
  _instance = scheduler;
}

export function getTeamLifecycleScheduler(): TeamLifecycleScheduler | null {
  return _instance;
}
