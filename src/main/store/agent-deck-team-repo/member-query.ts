/**
 * Agent Deck team-repo —— member 反查 helper（无副作用、纯 SQL SELECT）。
 *
 * 拆分历史：从 src/main/store/agent-deck-team-repo.ts 抽出（CHANGELOG_82 / plan
 * deep-review-and-split-20260513 H2 Step 2.2）。
 *
 * 不依赖 team-crud / member-crud；team-crud.getWithMembers 与 member-crud.addMember/setRole
 * 反过来依赖此处（read-side helper 无业务副作用）。
 */

import type { Database } from 'better-sqlite3';
import type {
  AgentDeckTeamMember,
  AgentDeckTeamMemberRole,
  SessionTeamMembership,
} from '@shared/types';
import { memberRowToRecord, type MemberRow } from './types';

export interface MemberQueryHelpers {
  /** 仅返回当前 active member（left_at IS NULL + 关联 session 未归档）—— 与 countActiveLeads / findSharedActiveTeams 语义一致。
   *
   * REVIEW_35 LOW-A1：修前不 JOIN sessions.archived_at IS NULL，会让「lead session 已归档但 membership 仍 active」的 ghost
   * member 被算入 active 列表。setRole 用 `listActiveMembers.length` 判断「demote last lead」时把 ghost 算进 totalActive 阻塞合法
   * demote。修法对齐其他两个 helper。
   */
  listActiveMembers(teamId: string): AgentDeckTeamMember[];
  /** 含 left（历史 + 当前）；UI 显示「曾经的 member」用 */
  listAllMembers(teamId: string): AgentDeckTeamMember[];
  /** PK lookup：某 session 在指定 team 的当前 active membership（buildWireBody 反查 displayName 用，避免全表扫）。 */
  findActiveMembershipIn(teamId: string, sessionId: string): AgentDeckTeamMember | null;
  /**
   * Row-active 反查：某 session 还有哪些 left_at IS NULL membership rows。
   * 保留 archived team 的 ghost membership，供 session/team revive 与历史协调路径使用。
   */
  findActiveMembershipsBySession(sessionId: string): AgentDeckTeamMember[];
  /**
   * Operational 反查：某 session 当前可操作的 active team membership。
   * 比 row-active 多过滤 agent_deck_teams.archived_at IS NULL，用于 task/handoff/send 这类
   * 不应把 archived team 当作可用协作范围的路径。
   */
  findActiveTeamMembershipsBySession(sessionId: string): AgentDeckTeamMember[];
  /**
   * 批量反查：一次拿多个 session 的 active membership + team name（plan team-cohesion-fix-20260513
   * Phase A）。返回 Map<sessionId, SessionTeamMembership[]> —— sessionId 不在结果里 → key 不存在
   * （caller 用 `.get(sid) ?? []`）。空数组入参直接返空 Map（避免 `IN ()` SQL 错）。
   * 大批量分块 CHUNK_SIZE = 500 防超 sqlite IN list 默认上限 999。
   */
  findActiveMembershipsBySessionIds(sessionIds: string[]): Map<string, SessionTeamMembership[]>;
  /** 反查：caller 与 target 共享的 active team id 集合（§5.2 send_message handler 用） */
  findSharedActiveTeams(sessionAId: string, sessionBId: string): string[];
  /** 当前 active lead 数（archive 0-lead 兜底用） */
  countActiveLeads(teamId: string): number;
}

export function createMemberQueryHelpers(db: Database): MemberQueryHelpers {
  function listActiveMembers(teamId: string): AgentDeckTeamMember[] {
    const rows = db
      .prepare(
        `SELECT m.* FROM agent_deck_team_members m
         INNER JOIN sessions s ON m.session_id = s.id
         WHERE m.team_id = ? AND m.left_at IS NULL AND s.archived_at IS NULL
         ORDER BY m.joined_at ASC`,
      )
      .all(teamId) as MemberRow[];
    return rows.map(memberRowToRecord);
  }

  function listAllMembers(teamId: string): AgentDeckTeamMember[] {
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_team_members
         WHERE team_id = ?
         ORDER BY joined_at ASC`,
      )
      .all(teamId) as MemberRow[];
    return rows.map(memberRowToRecord);
  }

  function findActiveMembershipIn(teamId: string, sessionId: string): AgentDeckTeamMember | null {
    // REVIEW_35 MED-A2：buildWireBody 反查 sender displayName 用 PK lookup 替代 listAllMembers 全表扫。
    // 走 (team_id, session_id) 复合 PK 索引（v010 schema），O(log N) 替代 O(M_team)。不 JOIN sessions
    // archived 过滤：wire body 应该在 sender session archived 后仍能渲染历史 displayName。
    const row = db
      .prepare(
        `SELECT * FROM agent_deck_team_members
         WHERE team_id = ? AND session_id = ? AND left_at IS NULL
         LIMIT 1`,
      )
      .get(teamId, sessionId) as MemberRow | undefined;
    return row ? memberRowToRecord(row) : null;
  }

  function findActiveMembershipsBySession(sessionId: string): AgentDeckTeamMember[] {
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_team_members
         WHERE session_id = ? AND left_at IS NULL
         ORDER BY joined_at DESC`,
      )
      .all(sessionId) as MemberRow[];
    return rows.map(memberRowToRecord);
  }

  function findActiveTeamMembershipsBySession(sessionId: string): AgentDeckTeamMember[] {
    const rows = db
      .prepare(
        `SELECT m.* FROM agent_deck_team_members m
         INNER JOIN agent_deck_teams t ON m.team_id = t.id
         WHERE m.session_id = ? AND m.left_at IS NULL AND t.archived_at IS NULL
         ORDER BY m.joined_at DESC`,
      )
      .all(sessionId) as MemberRow[];
    return rows.map(memberRowToRecord);
  }

  /**
   * 批量反查：JOIN agent_deck_teams 一次拿 team_name + 走 idx_team_members_active_session 部分索引。
   * 大批量 chunk 500（≤ sqlite IN list 默认上限 999），merge 各 chunk 结果到同 Map。
   *
   * 返回 Map：sid 不在结果里 → key 不存在（caller 用 `.get(sid) ?? []`）。
   * 多 team 共享同 sid 时按 joined_at DESC 排（最近加入的在前），与单 sid 版语义一致。
   */
  function findActiveMembershipsBySessionIds(
    sessionIds: string[],
  ): Map<string, SessionTeamMembership[]> {
    const result = new Map<string, SessionTeamMembership[]>();
    if (sessionIds.length === 0) return result;
    const CHUNK_SIZE = 500;
    interface JoinedRow {
      session_id: string;
      team_id: string;
      role: string;
      joined_at: number;
      team_name: string;
    }
    for (let i = 0; i < sessionIds.length; i += CHUNK_SIZE) {
      const chunk = sessionIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT m.session_id, m.team_id, m.role, m.joined_at, t.name AS team_name
           FROM agent_deck_team_members m
           INNER JOIN agent_deck_teams t ON m.team_id = t.id
           WHERE m.session_id IN (${placeholders}) AND m.left_at IS NULL
           ORDER BY m.session_id, m.joined_at DESC`,
        )
        .all(...chunk) as JoinedRow[];
      for (const r of rows) {
        const arr = result.get(r.session_id) ?? [];
        arr.push({
          teamId: r.team_id,
          teamName: r.team_name,
          role: (r.role === 'lead' ? 'lead' : 'teammate') as AgentDeckTeamMemberRole,
          joinedAt: r.joined_at,
        });
        result.set(r.session_id, arr);
      }
    }
    return result;
  }

  function findSharedActiveTeams(sessionAId: string, sessionBId: string): string[] {
    if (sessionAId === sessionBId) return [];
    // REVIEW_32 HIGH-2：JOIN agent_deck_teams 过滤 archived_at IS NULL + JOIN sessions 过滤双方 session
    // archived_at IS NULL —— 与 send_message 业务边界一致（archived team 或归档 session 不应继续 cross-adapter
    // dispatch）。修前 last-lead-archived 自动归档 / 用户主动归档后，membership 仍 active → send_message
    // 误以为 team 还能用 → enqueue 进 watcher → adapter.receiveTeammateMessage 把消息送给已"隐藏"的 teammate。
    const rows = db
      .prepare(
        `SELECT a.team_id AS team_id
         FROM agent_deck_team_members a
         INNER JOIN agent_deck_team_members b ON a.team_id = b.team_id
         INNER JOIN agent_deck_teams t ON a.team_id = t.id
         INNER JOIN sessions sa ON a.session_id = sa.id
         INNER JOIN sessions sb ON b.session_id = sb.id
         WHERE a.session_id = ? AND b.session_id = ?
           AND a.left_at IS NULL AND b.left_at IS NULL
           AND t.archived_at IS NULL
           AND sa.archived_at IS NULL AND sb.archived_at IS NULL`,
      )
      .all(sessionAId, sessionBId) as { team_id: string }[];
    return rows.map((r) => r.team_id);
  }

  function countActiveLeads(teamId: string): number {
    // bug 修复（plan deep-review-and-split-20260513）：lead session 被用户归档后，
    // 该 lead 不应再算作 active。INNER JOIN sessions 过滤 archived_at IS NULL，
    // 让 0-lead auto-archive 路径（manager.ts archive(sessionId) 联动 + _leaveAllActiveTeams）
    // 正确触发。membership 仍保留（lead 没真离开），只是计数视角下不算 active。
    const row = db
      .prepare(
        `SELECT count(*) AS c FROM agent_deck_team_members m
         INNER JOIN sessions s ON m.session_id = s.id
         WHERE m.team_id = ? AND m.role = 'lead'
           AND m.left_at IS NULL AND s.archived_at IS NULL`,
      )
      .get(teamId) as { c: number };
    return row.c;
  }

  return {
    listActiveMembers,
    listAllMembers,
    findActiveMembershipIn,
    findActiveMembershipsBySession,
    findActiveTeamMembershipsBySession,
    findActiveMembershipsBySessionIds,
    findSharedActiveTeams,
    countActiveLeads,
  };
}
