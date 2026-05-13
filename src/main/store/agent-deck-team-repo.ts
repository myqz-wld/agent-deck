/**
 * Agent Deck Universal Team Backend repo（R3.E3 / E0 ADR §3）。
 *
 * 持久层：agent_deck_teams + agent_deck_team_members 两表 CRUD。
 * agent_deck_messages 走单独 message-repo（避免单文件过大 + 关注点分离）。
 *
 * 设计要点：
 * - 同步 SQL（与 task-repo / session-repo / event-repo 风格一致）
 * - WAL + 单进程，FK 在 db.ts 内 PRAGMA foreign_keys = ON 已启用
 * - 通过 `createAgentDeckTeamRepo(db)` 工厂注入 db，让测试用 in-memory 数据库独立跑
 * - 默认导出 `agentDeckTeamRepo` 懒拿 getDb()，运行时调用方无感
 *
 * Invariant 强制（ADR §2.1，repo 层而非 SQL trigger）：
 * - active team 必须至少 1 lead（首次 addMember 例外：建 team 后允许短暂无 member 状态）
 * - lead 数量 ≤ 10
 * - 严格在 setRole / removeMember / leaveTeam 时校验，violation 抛 InvariantError
 *
 * 与 sessionManager.delete pre-check 协作（ADR §2.5）：
 * - sessions ON DELETE RESTRICT：直接 DELETE FROM sessions throw FK constraint failed
 * - sessionManager.delete 内调 findActiveMembershipsBySession + 自动 leaveTeam（写
 *   left_at 而非物理删 row，保留历史）+ 触发 0-lead 自动 archive
 */
import type { Database } from 'better-sqlite3';
import type {
  AgentDeckTeam,
  AgentDeckTeamArchiveReason,
  AgentDeckTeamMember,
  AgentDeckTeamMemberRole,
  SessionTeamMembership,
} from '@shared/types';
import { getDb } from './db';

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

/** repo 层 invariant 违反（ADR §2.1）；caller 看到 throw 应当 catch + 给用户提示 */
export class TeamInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamInvariantError';
  }
}

/** team 不存在或已 hard-delete */
export class TeamNotFoundError extends Error {
  constructor(public teamId: string) {
    super(`team not found: ${teamId}`);
    this.name = 'TeamNotFoundError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 行 → record 转换
// ────────────────────────────────────────────────────────────────────────────

interface TeamRow {
  id: string;
  name: string;
  created_at: number;
  archived_at: number | null;
  // REVIEW_32 MED-7: v016 加列；旧数据 NULL
  archive_reason: string | null;
  metadata: string;
}

interface MemberRow {
  team_id: string;
  session_id: string;
  role: string;
  display_name: string | null;
  joined_at: number;
  left_at: number | null;
}

function teamRowToRecord(r: TeamRow): AgentDeckTeam {
  // metadata: 存的是 JSON 字符串（CHECK json_valid 保证可解析）
  // 解析失败兜底：返空对象 + warn（防御 future schema 漂移）
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(r.metadata) as Record<string, unknown>;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      console.warn(`[agent-deck-team-repo] team ${r.id} metadata 不是 object，退化空对象：${r.metadata}`);
      metadata = {};
    }
  } catch (e) {
    console.warn(`[agent-deck-team-repo] team ${r.id} metadata JSON 解析失败：${e}`);
    metadata = {};
  }
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
    // REVIEW_32 MED-7：v016 加列；旧数据 NULL（视为「未知来源」，unarchive 联动不复活）
    archiveReason: (r.archive_reason as AgentDeckTeam['archiveReason']) ?? null,
    metadata,
  };
}

function memberRowToRecord(r: MemberRow): AgentDeckTeamMember {
  if (r.role !== 'lead' && r.role !== 'teammate') {
    // SQL CHECK 已挡，理论上不应到这里；防御性 fallback
    console.warn(`[agent-deck-team-repo] member ${r.team_id}/${r.session_id} role ${r.role} 不合法，退化 teammate`);
  }
  return {
    teamId: r.team_id,
    sessionId: r.session_id,
    role: (r.role === 'lead' ? 'lead' : 'teammate') as AgentDeckTeamMemberRole,
    displayName: r.display_name,
    joinedAt: r.joined_at,
    leftAt: r.left_at,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Input shapes
// ────────────────────────────────────────────────────────────────────────────

export interface CreateTeamInput {
  /** 1-128 char；active 内 unique（部分索引落地） */
  name: string;
  /** JSON 自由扩展位（描述 / 标签 / 来源 'cli'/'ui'/'mcp' 等） */
  metadata?: Record<string, unknown>;
}

export interface AddMemberInput {
  teamId: string;
  sessionId: string;
  role: AgentDeckTeamMemberRole;
  displayName?: string | null;
}

export interface ListTeamsOptions {
  /** true = 仅 active（archived_at IS NULL）；false = 含 archived；默认 true */
  activeOnly?: boolean;
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Repo
// ────────────────────────────────────────────────────────────────────────────

const MAX_LEADS_PER_TEAM = 10;

export interface AgentDeckTeamRepo {
  // ─── team CRUD ───
  /**
   * 建 team。name 在 active set 内 unique（部分索引）：重复 active name 抛 SQLITE_CONSTRAINT；
   * 已 archived 的同名 team 不冲突。
   *
   * 用 INSERT ... ON CONFLICT DO NOTHING + 同步 SELECT 序列化（避免长事务与 watcher poll
   * 抢 WAL 写锁），保证 spawn_session ensure-team-by-name 并发安全（ADR §5.1）。
   */
  create(input: CreateTeamInput): AgentDeckTeam;
  /**
   * 同 name 的 active team 已存在则返回该 team；否则建一个新 team（ensure-by-name 语义）。
   * spawn_session 用此入口（ADR §5.1）。
   */
  ensureByName(name: string, metadata?: Record<string, unknown>): AgentDeckTeam;
  get(teamId: string): AgentDeckTeam | null;
  getByActiveName(name: string): AgentDeckTeam | null;
  getWithMembers(teamId: string): (AgentDeckTeam & { members: AgentDeckTeamMember[] }) | null;
  list(opts?: ListTeamsOptions): AgentDeckTeam[];
  /** 标 archived_at = now() + archive_reason；不删行。reason 默认 'user-action'。 */
  archive(teamId: string, opts?: { reason?: AgentDeckTeamArchiveReason }): AgentDeckTeam | null;
  /** 撤销 archive（archived_at = NULL）；如有 active 同名 team 则 throw（部分 unique 冲突） */
  unarchive(teamId: string): AgentDeckTeam | null;
  /**
   * 物理删除（CASCADE 删 members + messages，SET NULL 在 tasks.team_id）。
   * 仅管理 / 测试用。生产用 archive 而非 hardDelete。
   */
  hardDelete(teamId: string): boolean;

  // ─── member CRUD ───
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
  /** 仅返回当前 active member（left_at IS NULL） */
  listActiveMembers(teamId: string): AgentDeckTeamMember[];
  /** 含 left（历史 + 当前）；UI 显示「曾经的 member」用 */
  listAllMembers(teamId: string): AgentDeckTeamMember[];
  /** 反查：某 session 当前 active 在哪些 team */
  findActiveMembershipsBySession(sessionId: string): AgentDeckTeamMember[];
  /**
   * 批量反查：一次拿多个 session 的 active membership + team name（plan team-cohesion-fix-20260513 Phase A）。
   *
   * 返回 Map<sessionId, SessionTeamMembership[]> —— sessionId 不在结果里 → key 不存在
   * （caller 用 `.get(sid) ?? []`）。空数组入参直接返空 Map（避免 `IN ()` SQL 错）。
   *
   * SQL 走 `idx_team_members_active_session` 部分索引（session_id, team_id WHERE left_at IS NULL）+
   * INNER JOIN agent_deck_teams 一次拿 team_name，避免 caller 再 N 次 query teams 表。
   *
   * 大批量分块（CHUNK_SIZE = 500）防超 sqlite IN list 默认上限（999）。典型 list 路径
   * ≤ 200 sessions 单 query 足够；大于阈值的 hot path（如启动时全量 enrich）走分块自动 merge。
   */
  findActiveMembershipsBySessionIds(sessionIds: string[]): Map<string, SessionTeamMembership[]>;
  /** 反查：caller 与 target 共享的 active team id 集合（§5.2 send_message handler 用） */
  findSharedActiveTeams(sessionAId: string, sessionBId: string): string[];
  /** 当前 active lead 数（archive 0-lead 兜底用） */
  countActiveLeads(teamId: string): number;
  /** 改 role（lead ↔ teammate）。改前校验 lead 数上限 */
  setRole(teamId: string, sessionId: string, role: AgentDeckTeamMemberRole): AgentDeckTeamMember | null;
}

export function createAgentDeckTeamRepo(db: Database): AgentDeckTeamRepo {
  // ─── team CRUD impl ───

  function create(input: CreateTeamInput): AgentDeckTeam {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('team name 不能为空');
    if (name.length > 128) throw new Error('team name 长度超过 128 字符');

    const id = crypto.randomUUID();
    const now = Date.now();
    const metadata = JSON.stringify(input.metadata ?? {});

    try {
      db.prepare(
        `INSERT INTO agent_deck_teams (id, name, created_at, archived_at, metadata)
         VALUES (?, ?, ?, NULL, ?)`,
      ).run(id, name, now, metadata);
    } catch (e) {
      // unique 冲突（active 同名 team 已存在）
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
        throw new TeamInvariantError(`active team name "${name}" 已存在`);
      }
      throw e;
    }
    const created = get(id);
    if (!created) throw new Error(`team ${id} 创建后查询失败`);
    return created;
  }

  function ensureByName(name: string, metadata?: Record<string, unknown>): AgentDeckTeam {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new Error('team name 不能为空');
    if (trimmed.length > 128) throw new Error('team name 长度超过 128 字符');

    // 优先查现有 active
    const existing = getByActiveName(trimmed);
    if (existing) return existing;

    // 不存在则 INSERT；并发竞争时部分 unique 索引会拒第二个，捕获后再 SELECT
    const id = crypto.randomUUID();
    const now = Date.now();
    const metadataJson = JSON.stringify(metadata ?? {});

    try {
      db.prepare(
        `INSERT INTO agent_deck_teams (id, name, created_at, archived_at, metadata)
         VALUES (?, ?, ?, NULL, ?)`,
      ).run(id, trimmed, now, metadataJson);
      const created = get(id);
      if (!created) throw new Error(`team ${id} 创建后查询失败`);
      return created;
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
        // 并发竞争：已被另一个 caller 抢先 INSERT；重新 SELECT 拿到那个
        const winner = getByActiveName(trimmed);
        if (winner) return winner;
        // 极少见：竞争者刚 archive 了；fallback 抛 invariant
        throw new TeamInvariantError(`ensure-by-name "${trimmed}" 竞争失败：active winner 已消失`);
      }
      throw e;
    }
  }

  function get(teamId: string): AgentDeckTeam | null {
    const row = db
      .prepare(`SELECT * FROM agent_deck_teams WHERE id = ?`)
      .get(teamId) as TeamRow | undefined;
    return row ? teamRowToRecord(row) : null;
  }

  function getByActiveName(name: string): AgentDeckTeam | null {
    const row = db
      .prepare(`SELECT * FROM agent_deck_teams WHERE name = ? AND archived_at IS NULL LIMIT 1`)
      .get(name) as TeamRow | undefined;
    return row ? teamRowToRecord(row) : null;
  }

  function getWithMembers(
    teamId: string,
  ): (AgentDeckTeam & { members: AgentDeckTeamMember[] }) | null {
    const team = get(teamId);
    if (!team) return null;
    const members = listAllMembers(teamId);
    return { ...team, members };
  }

  function list(opts?: ListTeamsOptions): AgentDeckTeam[] {
    const activeOnly = opts?.activeOnly ?? true;
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);

    const where = activeOnly ? 'WHERE archived_at IS NULL' : '';
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_teams ${where}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as TeamRow[];
    return rows.map(teamRowToRecord);
  }

  function archive(teamId: string, opts?: { reason?: AgentDeckTeamArchiveReason }): AgentDeckTeam | null {
    const now = Date.now();
    // REVIEW_32 MED-7：持久化 archive_reason 到 v016 列。caller 不传 → 'user-action'（默认即用户主动）。
    // 配合 unarchive 联动只复活 'last-lead-archived'，避免覆盖用户主动归档语义。
    const reason: AgentDeckTeamArchiveReason = opts?.reason ?? 'user-action';
    const result = db
      .prepare(
        `UPDATE agent_deck_teams SET archived_at = ?, archive_reason = ?
         WHERE id = ? AND archived_at IS NULL`,
      )
      .run(now, reason, teamId);
    if (result.changes === 0) {
      // 已 archived 或不存在
      return get(teamId);
    }
    return get(teamId);
  }

  function unarchive(teamId: string): AgentDeckTeam | null {
    const team = get(teamId);
    if (!team) return null;
    if (team.archivedAt === null) return team; // 已 active
    try {
      // REVIEW_32 MED-7：unarchive 时同时清 archive_reason
      db.prepare(`UPDATE agent_deck_teams SET archived_at = NULL, archive_reason = NULL WHERE id = ?`).run(teamId);
    } catch (e) {
      // active 同名 team 占位 → 部分 unique 索引拒绝
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
        throw new TeamInvariantError(
          `unarchive failed: active team named "${team.name}" already exists`,
        );
      }
      throw e;
    }
    return get(teamId);
  }

  function hardDelete(teamId: string): boolean {
    const result = db.prepare(`DELETE FROM agent_deck_teams WHERE id = ?`).run(teamId);
    return result.changes > 0;
  }

  // ─── member CRUD impl ───

  function addMember(input: AddMemberInput): AgentDeckTeamMember {
    const { teamId, sessionId, role } = input;
    const displayName = input.displayName ?? null;

    // 校验 team 存在
    if (!get(teamId)) throw new TeamNotFoundError(teamId);

    // 检查现有 row（同 PK）
    const existing = db
      .prepare(`SELECT * FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`)
      .get(teamId, sessionId) as MemberRow | undefined;

    if (existing) {
      if (existing.left_at === null) {
        throw new TeamInvariantError(
          `member ${sessionId} already active in team ${teamId}`,
        );
      }
      // rejoin：更新 role / display_name / joined_at = now / left_at = NULL
      // 校验 lead 数（rejoin 为 lead 时）
      if (role === 'lead' && countActiveLeads(teamId) >= MAX_LEADS_PER_TEAM) {
        throw new TeamInvariantError(
          `team ${teamId} lead count ${countActiveLeads(teamId)} >= ${MAX_LEADS_PER_TEAM}`,
        );
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
    if (role === 'lead' && countActiveLeads(teamId) >= MAX_LEADS_PER_TEAM) {
      throw new TeamInvariantError(
        `team ${teamId} lead count ${countActiveLeads(teamId)} >= ${MAX_LEADS_PER_TEAM}`,
      );
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

  function listActiveMembers(teamId: string): AgentDeckTeamMember[] {
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_team_members
         WHERE team_id = ? AND left_at IS NULL
         ORDER BY joined_at ASC`,
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
    if (role === 'lead' && countActiveLeads(teamId) >= MAX_LEADS_PER_TEAM) {
      throw new TeamInvariantError(
        `team ${teamId} lead count ${countActiveLeads(teamId)} >= ${MAX_LEADS_PER_TEAM}`,
      );
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
        const totalActive = listActiveMembers(teamId).length;
        if (totalActive > 0) {
          throw new TeamInvariantError(
            `cannot demote last lead in non-empty team ${teamId}`,
          );
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
    create,
    ensureByName,
    get,
    getByActiveName,
    getWithMembers,
    list,
    archive,
    unarchive,
    hardDelete,
    addMember,
    leaveTeam,
    listActiveMembers,
    listAllMembers,
    findActiveMembershipsBySession,
    findActiveMembershipsBySessionIds,
    findSharedActiveTeams,
    countActiveLeads,
    setRole,
  };
}

/** 默认 repo：模块加载时 getDb() 还没 init，所以不能 eager 构造；缓存到模块 closure */
let _defaultRepo: AgentDeckTeamRepo | null = null;
function defaultRepo(): AgentDeckTeamRepo {
  if (!_defaultRepo) _defaultRepo = createAgentDeckTeamRepo(getDb());
  return _defaultRepo;
}

export const agentDeckTeamRepo: AgentDeckTeamRepo = {
  create: (input) => defaultRepo().create(input),
  ensureByName: (name, metadata) => defaultRepo().ensureByName(name, metadata),
  get: (teamId) => defaultRepo().get(teamId),
  getByActiveName: (name) => defaultRepo().getByActiveName(name),
  getWithMembers: (teamId) => defaultRepo().getWithMembers(teamId),
  list: (opts) => defaultRepo().list(opts),
  archive: (teamId, opts) => defaultRepo().archive(teamId, opts),
  unarchive: (teamId) => defaultRepo().unarchive(teamId),
  hardDelete: (teamId) => defaultRepo().hardDelete(teamId),
  addMember: (input) => defaultRepo().addMember(input),
  leaveTeam: (teamId, sessionId) => defaultRepo().leaveTeam(teamId, sessionId),
  listActiveMembers: (teamId) => defaultRepo().listActiveMembers(teamId),
  listAllMembers: (teamId) => defaultRepo().listAllMembers(teamId),
  findActiveMembershipsBySession: (sessionId) => defaultRepo().findActiveMembershipsBySession(sessionId),
  findActiveMembershipsBySessionIds: (sessionIds) =>
    defaultRepo().findActiveMembershipsBySessionIds(sessionIds),
  findSharedActiveTeams: (a, b) => defaultRepo().findSharedActiveTeams(a, b),
  countActiveLeads: (teamId) => defaultRepo().countActiveLeads(teamId),
  setRole: (teamId, sessionId, role) => defaultRepo().setRole(teamId, sessionId, role),
};
