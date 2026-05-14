/**
 * Agent Deck team-repo —— member CRUD（addMember / leaveTeam / setRole）。
 *
 * 拆分历史：从 src/main/store/agent-deck-team-repo.ts 抽出（CHANGELOG_82 / plan
 * deep-review-and-split-20260513 H2 Step 2.2）。
 *
 * 依赖：
 * - team-crud.get（addMember 校验 team 存在）
 * - member-query.countActiveLeads / listActiveMembers（addMember/setRole 的 lead 数 / 「至少 1 lead」校验）
 */

import type { Database } from 'better-sqlite3';
import type { AgentDeckTeamMember, AgentDeckTeamMemberRole } from '@shared/types';

import {
  MAX_LEADS_PER_TEAM,
  TeamInvariantError,
  TeamNotFoundError,
  memberRowToRecord,
  type AddMemberInput,
  type MemberRow,
} from './types';
import type { TeamCrudHelpers } from './team-crud';
import type { MemberQueryHelpers } from './member-query';

export interface MemberCrudHelpers {
  /**
   * 加 member。同 (team_id, session_id) PK 已存在则按 left_at 状态判断：
   * - left_at IS NULL: throw `member already active`
   * - left_at 非 NULL: 当 rejoin 处理（更新 role / display_name / joined_at = now / left_at = NULL）
   *
   * 加 lead 时校验上限（≤ MAX_LEADS_PER_TEAM = 10）；超过 throw TeamInvariantError。
   */
  addMember(input: AddMemberInput): AgentDeckTeamMember;
  /**
   * 离开 team（写 left_at = now，不删 row）。
   * 如该 member 是 lead 且离开后 active lead 数 = 0 → 触发 0-lead 兜底（caller 自己决定
   * 是否调 archive，本 repo 不主动 archive 以保持单一职责）。
   */
  leaveTeam(teamId: string, sessionId: string): AgentDeckTeamMember | null;
  /** 改 role（lead ↔ teammate）。改前校验 lead 数上限 */
  setRole(
    teamId: string,
    sessionId: string,
    role: AgentDeckTeamMemberRole,
  ): AgentDeckTeamMember | null;
}

export function createMemberCrudHelpers(
  db: Database,
  teamCrud: Pick<TeamCrudHelpers, 'get'>,
  memberQuery: Pick<MemberQueryHelpers, 'countActiveLeads' | 'listActiveMembers'>,
): MemberCrudHelpers {
  function addMember(input: AddMemberInput): AgentDeckTeamMember {
    const { teamId, sessionId, role } = input;
    const displayName = input.displayName ?? null;

    // 校验 team 存在
    if (!teamCrud.get(teamId)) throw new TeamNotFoundError(teamId);

    // 检查现有 row（同 PK）
    const existing = db
      .prepare(`SELECT * FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`)
      .get(teamId, sessionId) as MemberRow | undefined;

    if (existing) {
      if (existing.left_at === null) {
        throw new TeamInvariantError(`member ${sessionId} already active in team ${teamId}`);
      }
      // rejoin：更新 role / display_name / joined_at = now / left_at = NULL
      // 校验 lead 数（rejoin 为 lead 时）
      if (role === 'lead') {
        // REVIEW_35 LOW-A2：缓存 countActiveLeads 避免错误信息里二次 SQL
        const leadCount = memberQuery.countActiveLeads(teamId);
        if (leadCount >= MAX_LEADS_PER_TEAM) {
          throw new TeamInvariantError(
            `team ${teamId} lead count ${leadCount} >= ${MAX_LEADS_PER_TEAM}`,
          );
        }
      }
      db.prepare(
        `UPDATE agent_deck_team_members
         SET role = ?, display_name = ?, joined_at = ?, left_at = NULL
         WHERE team_id = ? AND session_id = ?`,
      ).run(role, displayName, Date.now(), teamId, sessionId);
      const updated = db
        .prepare(`SELECT * FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`)
        .get(teamId, sessionId) as MemberRow;
      return memberRowToRecord(updated);
    }

    // 新加：lead 数校验
    if (role === 'lead') {
      // REVIEW_35 LOW-A2：缓存 countActiveLeads 避免错误信息里二次 SQL
      const leadCount = memberQuery.countActiveLeads(teamId);
      if (leadCount >= MAX_LEADS_PER_TEAM) {
        throw new TeamInvariantError(
          `team ${teamId} lead count ${leadCount} >= ${MAX_LEADS_PER_TEAM}`,
        );
      }
    }

    db.prepare(
      `INSERT INTO agent_deck_team_members
       (team_id, session_id, role, display_name, joined_at, left_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(teamId, sessionId, role, displayName, Date.now());

    const created = db
      .prepare(`SELECT * FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`)
      .get(teamId, sessionId) as MemberRow;
    return memberRowToRecord(created);
  }

  function leaveTeam(teamId: string, sessionId: string): AgentDeckTeamMember | null {
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE agent_deck_team_members SET left_at = ?
         WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
      )
      .run(now, teamId, sessionId);
    if (result.changes === 0) return null;
    const updated = db
      .prepare(`SELECT * FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`)
      .get(teamId, sessionId) as MemberRow | undefined;
    return updated ? memberRowToRecord(updated) : null;
  }

  function setRole(
    teamId: string,
    sessionId: string,
    role: AgentDeckTeamMemberRole,
  ): AgentDeckTeamMember | null {
    const existing = db
      .prepare(
        `SELECT * FROM agent_deck_team_members
         WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
      )
      .get(teamId, sessionId) as MemberRow | undefined;
    if (!existing) return null;
    if (existing.role === role) return memberRowToRecord(existing); // no-op

    // teammate → lead 时校验上限
    if (role === 'lead') {
      // REVIEW_35 LOW-A2：缓存 countActiveLeads 避免错误信息里二次 SQL
      const leadCount = memberQuery.countActiveLeads(teamId);
      if (leadCount >= MAX_LEADS_PER_TEAM) {
        throw new TeamInvariantError(
          `team ${teamId} lead count ${leadCount} >= ${MAX_LEADS_PER_TEAM}`,
        );
      }
    }
    // lead → teammate 时校验「至少 1 lead」（仅当 active members > 0 时强制；空 team 允许无 lead）
    if (role === 'teammate' && existing.role === 'lead') {
      // REVIEW_32 HIGH-6：JOIN sessions 过滤 archived_at IS NULL，与 countActiveLeads 语义一致。
      // 修前：team 有 lead-A（session archived） + lead-B（active）。把 lead-B 降级 → otherLeads=1
      // （把 archived 的 lead-A 算上）→ check 通过 → demote 成功。但 countActiveLeads(T)=0 → 团队进入
      // 「无可用 lead」死状态：A 不能干活、B 已不是 lead，_archiveTeamsIfOrphaned 不触发（demote 走
      // setRole 不调 archive 联动）、scheduler D7 也不命中（A 是 archived 不是 closed）→ 永远幽灵。
      const otherLeads = db
        .prepare(
          `SELECT count(*) AS c FROM agent_deck_team_members m
           INNER JOIN sessions s ON m.session_id = s.id
           WHERE m.team_id = ? AND m.session_id != ? AND m.role = 'lead'
             AND m.left_at IS NULL AND s.archived_at IS NULL`,
        )
        .get(teamId, sessionId) as { c: number };
      if (otherLeads.c === 0) {
        const totalActive = memberQuery.listActiveMembers(teamId).length;
        if (totalActive > 0) {
          throw new TeamInvariantError(`cannot demote last lead in non-empty team ${teamId}`);
        }
      }
    }

    db.prepare(
      `UPDATE agent_deck_team_members SET role = ?
       WHERE team_id = ? AND session_id = ?`,
    ).run(role, teamId, sessionId);

    const updated = db
      .prepare(`SELECT * FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`)
      .get(teamId, sessionId) as MemberRow;
    return memberRowToRecord(updated);
  }

  return {
    addMember,
    leaveTeam,
    setRole,
  };
}
