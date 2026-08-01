import type { SessionRecord } from '@shared/types';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';

/**
 * Session × team membership 拼装 helper（拆自 manager.ts，CHANGELOG_86 Step 4.3.1）。
 *
 * 纯 read enrich：不改 SessionRecord、不写 DB、不 emit 事件。两个 free function 由
 * SessionManagerClass.enrichWithTeams / enrichWithTeamsBatch 委托调用。
 *
 * agentDeckTeamRepo top-level import：vi.mock('@main/store/agent-deck-team-repo') 按
 * module specifier 拦截，与 caller 在哪个文件 import 无关。
 *
 * plan team-cohesion-fix-20260513 Phase A 历史决策保留（团队 chip / 角色切换 / lead
 * teamName 对称性）：拼装 teams[] 顺序按 joined_at DESC，与 SessionCard teams[0] 一致。
 */

/**
 * 单 record 版（hot path：每次 emit session-upserted 桥到 renderer 时调）。
 * indexed (session_id, team_id) WHERE left_at IS NULL 单 query 是 ms 级。
 *
 * 不在 sessionRepo.toSessionRecord 内做（repo 层职责单一：纯 DB row → record）；
 * teams[] 投影由 sessionManager 编排层负责。
 */
export function enrichRecordWithTeams(rec: SessionRecord): SessionRecord {
  const memberships = agentDeckTeamRepo.findActiveMembershipsBySession(rec.id);
  const teams = memberships.map((m) => {
    // findActiveMembershipsBySession 返回 AgentDeckTeamMember（无 teamName），需多查一次 team
    const team = agentDeckTeamRepo.get(m.teamId);
    return {
      teamId: m.teamId,
      teamName: team?.name ?? '<unknown>',
      role: m.role,
      joinedAt: m.joinedAt,
    };
  });
  return { ...rec, teams };
}

/**
 * 批量版：list 路径用，避免 N+1（一次 IN 查 + 一次 IN teams JOIN）。
 * 走 agentDeckTeamRepo.findActiveMembershipsBySessionIds（已 JOIN agent_deck_teams 拿
 * teamName，chunk 500 防超 sqlite IN 上限）。
 */
export function enrichRecordsWithTeamsBatch(recs: SessionRecord[]): SessionRecord[] {
  if (recs.length === 0) return recs;
  const map = agentDeckTeamRepo.findActiveMembershipsBySessionIds(recs.map((r) => r.id));
  return recs.map((rec) => ({
    ...rec,
    teams: map.get(rec.id) ?? [],
  }));
}
