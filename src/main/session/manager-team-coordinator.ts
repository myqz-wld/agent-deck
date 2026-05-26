import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import type { AgentDeckTeamArchiveReason } from '@shared/types/agent-deck-team';

/**
 * Session × team 业务联动 helper（拆自 manager.ts，CHANGELOG_86 Step 4.3.2）。
 *
 * 三个 export 对应 SessionManagerClass 的 close/markClosed/delete/archive/unarchive 路径调用：
 * - leaveTeamsAndAutoArchive(sid, reason) — 合并自 `_leaveAllActiveTeams`（reason='closed'）+
 *   `delete()` 段 1（reason='deleted'）。两段原实现结构 100% 等价：双层 try/catch + 同序
 *   leaveTeam → emit member-changed → countActiveLeads → archive → emit team-updated；唯一
 *   不同是 archive reason 字符串 ('last-lead-closed' vs 'last-lead-deleted')，由参数 explicit map。
 * - archiveTeamsIfOrphaned(sid) — 与 `_archiveTeamsIfOrphaned` 等价，archive(sessionId) 联动用。
 * - unarchiveTeamsForRevivedLead(sid) — 与 `_unarchiveTeamsForRevivedLead` 等价，unarchive(sessionId) 联动用。
 *
 * Import 策略：
 * - eventBus 用 top-level import（与原 _leaveAllActiveTeams 一致，避免 close/markClosed
 *   路径的异常边界因 lazy await 多一个 microtask 而漂移；delete 段 1 历史 lazy 是遗物）。
 * - agentDeckTeamRepo 维持 lazy import (`await import(...)`)，与历史 _leaveAllActiveTeams 模式
 *   对称；现状已无真实 cycle（manager-enrich.ts 已 top-level import 它），是过保护，未来可考虑
 *   收编 top-level（但属本拆分外的另一次决策）。
 */

/** SessionManager.close/markClosed 走 'closed'，SessionManager.delete 走 'deleted'。 */
export type SessionEndReason = 'closed' | 'deleted';

/**
 * 合并自 `_leaveAllActiveTeams` (close/markClosed 用 reason='closed') + `delete()` 段 1
 * (reason='deleted')。
 *
 * 行为完全等价 except archive reason 由参数 explicit map：
 * 1. lazy import agentDeckTeamRepo + listActiveMemberships
 * 2. 逐个 leaveTeam(team_id, sid) 写 left_at = now
 * 3. emit `agent-deck-team-member-changed` 让 TeamHub / TeamDetail UI 刷新
 * 4. 0-lead 自动 archive：lead 离开后该 team 无 active lead → archive team + emit
 *    `agent-deck-team-updated`，archive reason 由本函数参数决定
 *
 * 注意：reactivate 路径**不**自动 rejoin team（草案 D6 反例考虑：语义不清，
 * 可能加错 team；reactivate 是少数场景，让用户手工 spawn 新 team 才稳）。
 *
 * @note **delete 路径调用 await 是 UX 正确性而非 FK 绕行**（plan linked-swimming-platypus
 *   v017 起 agent_deck_team_members.session_id FK 改 ON DELETE CASCADE，sessionRepo.delete
 *   走 CASCADE 自动级联清 member rows，不再撞 FK）。
 *   await 顺序是为了让 leaveTeam 先 emit 'agent-deck-team-member-changed' + 触发 0-lead
 *   auto-archive 后再 delete；颠倒顺序会让 CASCADE 已删 member rows，leaveTeam 找不到 active
 *   row → 不 emit member-changed → UI 不刷新 + archive 联动跑空。
 *   close/markClosed 路径 await 或 fire-and-forget 均可（语义独立）。
 */
export async function leaveTeamsAndAutoArchive(
  sessionId: string,
  reason: SessionEndReason,
): Promise<void> {
  // satisfies 守门：增删 SessionEndReason 时强制更新映射 + 与 AgentDeckTeamArchiveReason
  // 联合类型对齐；v016 不是 DB CHECK 约束（只是业务约定），靠 TS 类型层面拒接非法 reason
  const archiveReasonMap = {
    closed: 'last-lead-closed',
    deleted: 'last-lead-deleted',
  } satisfies Record<SessionEndReason, AgentDeckTeamArchiveReason>;
  try {
    const { agentDeckTeamRepo } = await import('@main/store/agent-deck-team-repo');
    const memberships = agentDeckTeamRepo.findActiveMembershipsBySession(sessionId);
    for (const m of memberships) {
      try {
        agentDeckTeamRepo.leaveTeam(m.teamId, sessionId);
        eventBus.emit('agent-deck-team-member-changed', {
          teamId: m.teamId,
          sessionId,
          kind: 'left',
        });
        // 0-lead 自动 archive：lead 离开后该 team 无 active lead → archive
        const remaining = agentDeckTeamRepo.countActiveLeads(m.teamId);
        if (remaining === 0) {
          const team = agentDeckTeamRepo.archive(m.teamId, { reason: archiveReasonMap[reason] });
          if (team) eventBus.emit('agent-deck-team-updated', team);
        }
      } catch (err) {
        console.warn(
          `[session-mgr] leaveTeam(${m.teamId}, ${sessionId}) failed during ${reason}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[session-mgr] leaveTeamsAndAutoArchive skipped (import failed): ${sessionId}`,
      err,
    );
  }
}

/**
 * lead session 被用户归档后，该 session 所属的 active team 若已无 active lead → auto-archive team。
 * 与 leaveTeamsAndAutoArchive 的区别：membership 不动（lead 没真离开，只是被隐藏），
 * 所以**不**调 leaveTeam、**不**emit team-member-changed。countActiveLeads 已加
 * INNER JOIN sessions archived_at IS NULL 过滤，本 sid 自动从计数中去除。
 * lazy import 防循环依赖（与 leaveTeamsAndAutoArchive 同模式）。
 */
export async function archiveTeamsIfOrphaned(sessionId: string): Promise<void> {
  try {
    const { agentDeckTeamRepo } = await import('@main/store/agent-deck-team-repo');
    const memberships = agentDeckTeamRepo.findActiveMembershipsBySession(sessionId);
    for (const m of memberships) {
      try {
        if (m.role !== 'lead') continue; // teammate 归档不影响 team 存活
        const remaining = agentDeckTeamRepo.countActiveLeads(m.teamId);
        if (remaining === 0) {
          const team = agentDeckTeamRepo.archive(m.teamId, { reason: 'last-lead-archived' });
          if (team) eventBus.emit('agent-deck-team-updated', team);
        }
      } catch (err) {
        console.warn(
          `[session-mgr] archiveTeamsIfOrphaned(${m.teamId}, ${sessionId}) failed:`,
          err,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[session-mgr] archiveTeamsIfOrphaned skipped (import failed): ${sessionId}`,
      err,
    );
  }
}

/**
 * lead session 复活时，所有该 session 还是 active member 且**因本会话 archive 联动**自动归档
 * (archive_reason='last-lead-archived') 的 team 一并 unarchive。
 *
 * REVIEW_32 MED-7：精确语义 — 只复活 'last-lead-archived'，绝不复活：
 * - 'user-action'（用户主动归档）
 * - 'last-lead-closed' / 'last-lead-deleted'（lead 真离开 team，membership 也已 leave，
 *   走不到本 helper 的 m.role==='lead' 分支）
 * - 'scheduler'（D7 长期无活动归档，应保持）
 *
 * teammate 归档/复活不影响 team 存活，所以只在 role='lead' 时触发。
 */
export async function unarchiveTeamsForRevivedLead(sessionId: string): Promise<void> {
  try {
    const { agentDeckTeamRepo } = await import('@main/store/agent-deck-team-repo');
    const memberships = agentDeckTeamRepo.findActiveMembershipsBySession(sessionId);
    for (const m of memberships) {
      try {
        if (m.role !== 'lead') continue;
        const team = agentDeckTeamRepo.get(m.teamId);
        if (!team || team.archivedAt === null) continue;
        // REVIEW_32 MED-7：只复活 archive_reason='last-lead-archived'，避免覆盖用户主动归档语义
        if (team.archiveReason !== 'last-lead-archived') continue;
        const restored = agentDeckTeamRepo.unarchive(m.teamId);
        if (restored) eventBus.emit('agent-deck-team-updated', restored);
      } catch (err) {
        console.warn(
          `[session-mgr] unarchiveTeamsForRevivedLead(${m.teamId}, ${sessionId}) failed:`,
          err,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[session-mgr] unarchiveTeamsForRevivedLead skipped (import failed): ${sessionId}`,
      err,
    );
  }
}

/**
 * **REVIEW_56 §F20 修法 (Plan-Review Round 1 + spike 决策, DRY)**: 抽出 session "becomes closed"
 * 副作用收口 helper,三入口(manager.markClosed / manager.close / lifecycle-scheduler purge)
 * 统一调用。
 *
 * **副作用顺序** (与历史 manager.ts L337-345 / L377-389 + lifecycle-scheduler.ts L93-115 等价):
 * 1. `sessionRepo.clearCwdReleaseMarker(sessionId)` (sync,错误隔离不阻塞下游)
 * 2. **caller-provided sync callback** `onClearedBeforeLeave` (各 caller 自己的 emit upserted /
 *    token release 等,在 leave 启动之前 sync 跑)
 * 3. `leaveTeamsAndAutoArchive(sessionId, 'closed')` (async)
 *
 * **awaitLeave 双模式** (历史三入口语义差异保留):
 * - **awaitLeave=false (default)**: fire-and-forget `void leave().catch(warn)` —
 *   sync caller (`manager.markClosed` / `lifecycle-scheduler` tick) 用 (不阻塞同步路径)
 * - **awaitLeave=true**: `await leave()` — async caller (`manager.close`) 用,让 caller 拿
 *   稳定状态返回 (UX 正确性:UI 反映 team-member-changed + 0-lead auto-archive 后再返)
 *
 * **logPrefix 可选** (保留各入口 console.warn 特异性,方便 ops grep):
 * - `'[session-mgr] markClosed'` / `'[session-mgr] close'` / `'[lifecycle-scheduler]'`
 * - default `'[applyClosedSideEffects]'` (helper 自身 fallback)
 *
 * **clearCwdReleaseMarker 错误隔离** (REVIEW_56 Batch C R3 reviewer-claude LOW-1 修法沿用):
 * 包 try/catch 防止 clearCwdReleaseMarker 抛错 (DB 异常 / row missing) 阻塞 leave + 0-lead
 * auto-archive 触发链。Leave 路径独立 try/catch (在 leaveTeamsAndAutoArchive 内本身)。
 *
 * **onClearedBeforeLeave callback** (sync only, 在 leave 启动之前同步段调) 让 caller 自己做:
 * - `manager.markClosed`: `eventBus.emit('session-upserted', sessionRepo.get(sid))` 让 renderer
 *   立即看到 cleared marker 的 fresh state
 * - `manager.close`: 同上 + `mcpSessionTokenMap.release(sid)` token 清理
 * - `lifecycle-scheduler`: 同 markClosed (refreshed = sessionRepo.get + emit)
 */
export async function applyClosedSideEffects(
  sessionId: string,
  opts: {
    awaitLeave?: boolean;
    logPrefix?: string;
    onClearedBeforeLeave?: () => void;
  } = {},
): Promise<void> {
  const prefix = opts.logPrefix ?? '[applyClosedSideEffects]';

  // 1. clear cwd_release_marker (sync, error isolated)
  try {
    sessionRepo.clearCwdReleaseMarker(sessionId);
  } catch (err) {
    console.warn(`${prefix} clearCwdReleaseMarker failed for ${sessionId}:`, err);
  }

  // 2. caller-provided sync callback (sync 段, between clear 和 leave)
  if (opts.onClearedBeforeLeave) {
    try {
      opts.onClearedBeforeLeave();
    } catch (err) {
      console.warn(`${prefix} onClearedBeforeLeave callback threw for ${sessionId}:`, err);
    }
  }

  // 3. leave teams + auto-archive (async, dual-mode)
  if (opts.awaitLeave) {
    await leaveTeamsAndAutoArchive(sessionId, 'closed');
  } else {
    void leaveTeamsAndAutoArchive(sessionId, 'closed').catch((err) => {
      console.warn(`${prefix} leaveTeamsAndAutoArchive failed for ${sessionId}:`, err);
    });
  }
}
