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
  /**
   * plan hand-off-session-adopt-teammates-20260520 Phase 5 (D4 + N1 zero dual-lead window):
   * lead role swap atomic — caller demote + newSid promote 在同一 transaction 内完成,外部
   * observer 永远看不到 dual-lead 中间态(better-sqlite3 单 connection serializable-like 隔离 —
   * spike2 v2 archive 联动隔离 attestation 实证)。
   *
   * **典型场景**:hand_off_session adopt_teammates: true 把 caller=lead 的 lead role 转给
   * 新 session(详 hand-off-session.ts handler adopt 分支 + plan §D5 baton-cleanup phase 1.5)。
   *
   * **三 case 分流**(transaction 内 Phase B 决策):
   * - **case 1 (adopt 主路径)**: newLeadSid 不在 team_member 表 → INSERT 新 row 为 lead,
   *   left_at=NULL + joined_at=now。adopt 路径 newLeadSid 是全新 spawn 永远不在 team(spawn
   *   不传 team_name → 不写 team_member),走此 case。
   * - **case 2 (rejoin path,adopt 路径不触发)**: newLeadSid 已 row 但 left_at!==null(历史
   *   软退出)→ UPDATE row 设 role='lead' + left_at=NULL + joined_at=now + display_name(若传)。
   *   adopt 路径 newSid 全新,**不会触发**;保留作 future-use defensive code(别 caller 路径
   *   手工 swapLead with existing sid 时支持)。
   * - **case 3 (防御幂等)**: newLeadSid 已 active row 且 role==='lead' → no-op + 仅 UPDATE
   *   display_name(若传)。N2.c 互斥 invariant 防 adopt 路径触发本 case(adopt 路径 newSid
   *   不在 team),但保留作 future-use defensive code。
   *
   * **MAX_LEADS_PER_TEAM bypass**(plan §已知踩坑 — Round 3 NEW INFO):case 1/2 走 raw SQL
   * INSERT/UPDATE,跳 addMember 内 countActiveLeads >= 10 校验。F1 use case 不撞(典型 1-2
   * lead/team)。**未来 N>=10 lead 场景需要时**,在 Phase B 前补 countActiveLeads check + return
   * swapped:false reason='max-leads'。
   *
   * **失败语义**(transaction 内 throw 自动 ROLLBACK):
   * - precheck 失败软退(swapped:false + reason 三档:'caller-not-in-team' / 'caller-not-lead' /
   *   `swap-lead-error: <e.message>`)— Phase A demote 未执行,caller 状态零变化
   * - precheck 通过后内部 throw 自动 ROLLBACK + return swapped:false reason='swap-lead-error: ...'
   *
   * @param teamId team id
   * @param oldLeadSid 原 lead session id(必须当前是 team 内 active lead,否则软退)
   * @param newLeadSid 新 lead session id(三 case 分流)
   * @param opts.newDisplayName 可选刷新 newLeadSid 的 display_name(三 case 都生效)
   * @returns `{ swapped: true }` 成功 / `{ swapped: false; reason }` 软失败
   */
  swapLead(
    teamId: string,
    oldLeadSid: string,
    newLeadSid: string,
    opts?: { newDisplayName?: string | null },
  ): { swapped: true } | { swapped: false; reason: string };
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

  /**
   * plan hand-off-session-adopt-teammates-20260520 Phase 5 swapLead 实现。
   * 详 MemberCrudHelpers.swapLead jsdoc(顶部 interface 内) — 三 case 分流 + transaction
   * atomic + N1 zero dual-lead window 保证。
   *
   * **transaction 内执行序**:
   * 1. Phase A.0 precheck:SELECT oldLeadSid 现有 row(team_id+session_id+left_at IS NULL)
   *    - 不在 team / 软失败 'caller-not-in-team'
   *    - 在但非 lead → 软失败 'caller-not-lead'
   * 2. Phase A demote:UPDATE oldLeadSid 设 left_at=now(等价 leaveTeam 但 transaction 内一致)
   * 3. Phase B promote:SELECT newLeadSid 现有 row 决策四 case
   *    - case 1 (无 row): INSERT 新 lead row
   *    - case 2 (left_at 非 null): UPDATE 设 role='lead' + left_at=NULL + joined_at=now [+ display_name]
   *    - case 3 (active+lead): no-op 或仅刷 display_name(防御 — N2.c 互斥防 adopt 路径触发)
   *    - case 4 (active+teammate): UPDATE 设 role='lead' [+ display_name 若传](N2.c 互斥防 adopt
   *      路径触发,别 caller 路径手工 swapLead with existing teammate sid 走此分支)
   *
   * **db.transaction(callback)** 自动 BEGIN/COMMIT/ROLLBACK(better-sqlite3 同款 spike2 v2 archive
   * 联动隔离 attestation 路径)。callback 内 throw 自动 ROLLBACK,return value 透传(precheck
   * 失败 return 软失败对象,Phase A/B 异常 throw 走 ROLLBACK)。
   */
  function swapLead(
    teamId: string,
    oldLeadSid: string,
    newLeadSid: string,
    opts?: { newDisplayName?: string | null },
  ): { swapped: true } | { swapped: false; reason: string } {
    const newDisplayName = opts?.newDisplayName ?? null;
    try {
      const result = db.transaction(() => {
        // Phase A.0: precheck oldLeadSid 是 active lead
        const callerRow = db
          .prepare(
            `SELECT role FROM agent_deck_team_members
             WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
          )
          .get(teamId, oldLeadSid) as { role: AgentDeckTeamMemberRole } | undefined;
        if (!callerRow) {
          // 软失败:caller 不在 team 或已软退出 — Phase A demote 不执行,caller 状态零变化
          return { swapped: false as const, reason: 'caller-not-in-team' };
        }
        if (callerRow.role !== 'lead') {
          // 软失败:caller 是 teammate 不是 lead — N5 上游 filter 已挡此 case 的 adopt 路径,
          // 但 swapLead 内 precheck 双重防御让别 caller 路径手工 swapLead 时也能正确软退
          return { swapped: false as const, reason: 'caller-not-lead' };
        }

        // Phase A: caller demote(SET left_at = now)
        // 不调 leaveTeam helper(避免 0-lead 兜底逻辑触发 — Phase B 紧接着 promote newLeadSid 接管)
        const now = Date.now();
        db.prepare(
          `UPDATE agent_deck_team_members SET left_at = ?
           WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
        ).run(now, teamId, oldLeadSid);

        // Phase B: newLeadSid promote 三 case 分流
        const existingNewRow = db
          .prepare(
            `SELECT role, left_at FROM agent_deck_team_members
             WHERE team_id = ? AND session_id = ?`,
          )
          .get(teamId, newLeadSid) as { role: AgentDeckTeamMemberRole; left_at: number | null } | undefined;

        if (!existingNewRow) {
          // case 1 (adopt 主路径): newLeadSid 不在 team → INSERT 新 lead row
          // **MAX_LEADS_PER_TEAM bypass**:不调 addMember 走 raw SQL(详 jsdoc 说明)
          db.prepare(
            `INSERT INTO agent_deck_team_members
             (team_id, session_id, role, display_name, joined_at, left_at)
             VALUES (?, ?, 'lead', ?, ?, NULL)`,
          ).run(teamId, newLeadSid, newDisplayName, now);
        } else if (existingNewRow.left_at !== null) {
          // case 2 (rejoin path,adopt 路径不触发): newLeadSid 已 row 但软退出 → UPDATE 复活为 lead
          db.prepare(
            `UPDATE agent_deck_team_members
             SET role = 'lead', left_at = NULL, joined_at = ?, display_name = ?
             WHERE team_id = ? AND session_id = ?`,
          ).run(now, newDisplayName, teamId, newLeadSid);
        } else if (existingNewRow.role === 'lead') {
          // case 3 (防御幂等): newLeadSid 已 active lead → no-op + 仅刷 display_name(若传)
          // N2.c 互斥防 adopt 路径触发本 case,但保留作 future-use defensive code
          if (newDisplayName !== null) {
            db.prepare(
              `UPDATE agent_deck_team_members
               SET display_name = ?
               WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
            ).run(newDisplayName, teamId, newLeadSid);
          }
        } else {
          // case 4 边角(active+teammate promote): newLeadSid 已 active 但是 teammate(非 lead)。
          // adopt 路径 N2.c 互斥防此 case;别 caller 路径手工 swapLead with existing teammate
          // sid 时走此分支 — promote teammate 为 lead(等价 setRole 但 raw SQL bypass MAX_LEADS_PER_TEAM)。
          //
          // REVIEW_56 Batch C R1 claude M-1 修法:与 case 3 (L307-316) 同款 newDisplayName !== null
          // 防御。旧实现 SQL `display_name = ?` 无防御,L256 `?? null` 在 caller 未传 / 显式传 null
          // 时落 null → SQL 把 NEW 行已有 displayName 无声清空。修法:newDisplayName 非 null 时
          // 走两列 UPDATE(role + display_name);为 null 时仅 SET role 不动 display_name,保留
          // NEW 行原 displayName 与 case 3 防御对齐。
          if (newDisplayName !== null) {
            db.prepare(
              `UPDATE agent_deck_team_members
               SET role = 'lead', display_name = ?
               WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
            ).run(newDisplayName, teamId, newLeadSid);
          } else {
            db.prepare(
              `UPDATE agent_deck_team_members
               SET role = 'lead'
               WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
            ).run(teamId, newLeadSid);
          }
        }

        return { swapped: true as const };
      })();
      return result;
    } catch (e) {
      // transaction 内 throw 自动 ROLLBACK(db.transaction 包装行为) — caller 状态零变化
      const errStr = e instanceof Error ? e.message : String(e);
      return { swapped: false as const, reason: `swap-lead-error: ${errStr}` };
    }
  }

  return {
    addMember,
    leaveTeam,
    setRole,
    swapLead,
  };
}
