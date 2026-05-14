/**
 * TeamEventDispatcher (§4.9) — best-effort notify adapter of teammate join/leave/archive
 *
 * 监听 `agent-deck-team-member-changed` / `agent-deck-team-updated` /
 * `agent-deck-team-created` 然后 fan-out 给同 team 所有 active member 的
 * adapter.notifyTeammateEvent。dispatcher 不等返回也不重试 —— 这只是观察性事件。
 *
 * **lifecycle 启动**：universal-message-watcher.start() 内部调 teamEventDispatcher.start()，
 * watcher.stop() 调 teamEventDispatcher.stop()。
 */

import { adapterRegistry } from '@main/adapters/registry';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type {
  AgentDeckTeamMember,
  AgentDeckTeammateEvent,
} from '@shared/types';

/**
 * 监听 `agent-deck-team-member-changed` / `agent-deck-team-updated` 然后 fan-out 给同 team
 * 所有 active member 的 adapter.notifyTeammateEvent。dispatcher 不等返回也不重试 ——
 * 这只是观察性事件。
 */
class TeamEventDispatcher {
  private offMember: (() => void) | null = null;
  private offUpdated: (() => void) | null = null;
  private offCreated: (() => void) | null = null;
  /** 缓存上次看到的 team archived_at，detect archive transition 用 */
  private lastArchivedAt = new Map<string, number | null>();

  start(): void {
    if (this.offMember) return;

    // C MED-D7 修（plan mcp-bug-and-feature-batch-20260513 Phase 2 Step 2.1）：dispatcher.start
    // 时一次性预填 lastArchivedAt cache，让所有已存在 team 的首次 transition（active→archived）
    // 能正常 detect。
    //
    // 修前：cache 初始空 → 任何 team 第一次 emit `agent-deck-team-updated` 时 prev=undefined →
    // 直接 return（line 234 「首次见到，不算变更」短路）→ archive transition 被吞，active member
    // 收不到 team-archived event。常见触发：lead session archive 联动 → countActiveLeads=0 → team
    // archive → emit team-updated → dispatcher 第一次见到该 team → prev=undefined → 吞。
    //
    // 修后：start 时分页 listAll team（含 archived）预填 archivedAt 真值，首次 emit 时 prev 已是
    // 真值，能正确 detect transition。pagination 与 E 修法（team-lifecycle-scheduler.ts）同款，
    // 防 long-running 实例 team > 200 时漏扫。
    try {
      const PAGE_SIZE = 200;
      let offset = 0;
      while (true) {
        const batch = agentDeckTeamRepo.list({ activeOnly: false, limit: PAGE_SIZE, offset });
        for (const team of batch) {
          this.lastArchivedAt.set(team.id, team.archivedAt);
        }
        if (batch.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
    } catch (err) {
      console.warn('[team-event-dispatcher] preseed lastArchivedAt failed:', err);
    }

    this.offMember = eventBus.on('agent-deck-team-member-changed', (ev) => {
      // 只关心 joined / left；role-changed 不触发 notify（团队 capability 没变）
      if (ev.kind === 'role-changed') return;
      const session = sessionRepo.get(ev.sessionId);
      const displayName = session?.title ?? ev.sessionId.slice(0, 8);
      const teammateEvent: AgentDeckTeammateEvent =
        ev.kind === 'joined'
          ? { kind: 'member-joined', teamId: ev.teamId, sessionId: ev.sessionId, displayName }
          : { kind: 'member-left', teamId: ev.teamId, sessionId: ev.sessionId, displayName };
      void this.fanOut(ev.teamId, teammateEvent, ev.sessionId);
    });
    this.offUpdated = eventBus.on('agent-deck-team-updated', (team) => {
      const prev = this.lastArchivedAt.get(team.id);
      const cur = team.archivedAt;
      this.lastArchivedAt.set(team.id, cur);
      // REVIEW_35 R2 HIGH-A1：旧版 `if (prev === undefined) return` 把任何「未见」team 一律
      // 当作 baseline 吞掉。但 spawn_session / cli / ipc.adapters.ts 三条创建路径走 ensureByName
      // **不**emit `agent-deck-team-created`（dispatcher 加的 offCreated listener 只 catch
      // ipc/teams.ts:128 UI 创建路径），导致这三条路径创建的 team 第一次 emit team-updated
      // (典型：lead session archive 联动 0-lead auto-archive → emit team-updated cur=archiveTs)
      // 仍 prev=undefined → return → team-archived notify 永久不发。
      // 修法：未见 team **且** cur=null 时才当 baseline；未见 team **但** cur!=null 时当作
      // 「未见就直接 archived」的 transition 处理。
      if (prev === undefined) {
        if (cur !== null) {
          // 未见过的 team 直接观察到 archived → 视作 archive transition fan-out
          void this.fanOut(team.id, { kind: 'team-archived', teamId: team.id }, null);
        }
        return;
      }
      // 仅关心从 active → archived 的变迁（unarchive 通常不需要打扰 active member）
      if (prev === null && cur !== null) {
        void this.fanOut(team.id, { kind: 'team-archived', teamId: team.id }, null);
      }
    });
    // REVIEW_35 MED-A1：dispatcher.start() 的 preseed 只 cover start 时已存在的 team。runtime
    // 新建的 team（典型：spawn_session 走 ensureByName 自动创建）从不入 cache，首次 emit
    // `agent-deck-team-updated` 时 prev=undefined → return → 吞掉。
    // 修法：订阅 `agent-deck-team-created` 把新 team 立刻入 cache（archivedAt 显然 null，但
    // 显式 set 而非 missing，区别开「未见 vs 见过 active」）。
    this.offCreated = eventBus.on('agent-deck-team-created', (team) => {
      this.lastArchivedAt.set(team.id, team.archivedAt);
    });
  }

  stop(): void {
    this.offMember?.();
    this.offUpdated?.();
    this.offCreated?.();
    this.offMember = null;
    this.offUpdated = null;
    this.offCreated = null;
    this.lastArchivedAt.clear();
  }

  private async fanOut(
    teamId: string,
    event: AgentDeckTeammateEvent,
    excludeSessionId: string | null,
  ): Promise<void> {
    let members: AgentDeckTeamMember[];
    try {
      members = agentDeckTeamRepo.listActiveMembers(teamId);
    } catch (err) {
      console.warn(`[team-event-dispatcher] listActiveMembers failed for team ${teamId}:`, err);
      return;
    }
    const targets = members.filter((m) => m.sessionId !== excludeSessionId);
    await Promise.allSettled(
      targets.map((m) => this.notifyOne(m.sessionId, event)),
    );
  }

  private async notifyOne(sessionId: string, event: AgentDeckTeammateEvent): Promise<void> {
    const session = sessionRepo.get(sessionId);
    if (!session) return;
    const adapter = adapterRegistry.get(session.agentId);
    if (!adapter?.notifyTeammateEvent) return;
    try {
      await adapter.notifyTeammateEvent(sessionId, event);
    } catch (err) {
      // best-effort：不重试，仅 warn
      console.warn(
        `[team-event-dispatcher] notifyTeammateEvent failed for ${sessionId} (${session.agentId}):`,
        err,
      );
    }
  }
}

const teamEventDispatcher = new TeamEventDispatcher();
export { teamEventDispatcher };
