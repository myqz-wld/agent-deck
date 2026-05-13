/**
 * Agent Deck team-repo —— team CRUD（建/查/列出/归档/取消归档/硬删）。
 *
 * 拆分历史：从 src/main/store/agent-deck-team-repo.ts 抽出（CHANGELOG_82 / plan
 * deep-review-and-split-20260513 H2 Step 2.2）。
 *
 * 依赖：member-query.listAllMembers（getWithMembers 用）。
 */

import type { Database } from 'better-sqlite3';
import type { AgentDeckTeam, AgentDeckTeamArchiveReason, AgentDeckTeamMember } from '@shared/types';

import {
  TeamInvariantError,
  teamRowToRecord,
  type CreateTeamInput,
  type ListTeamsOptions,
  type TeamRow,
} from './types';
import type { MemberQueryHelpers } from './member-query';

export interface TeamCrudHelpers {
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
}

export function createTeamCrudHelpers(
  db: Database,
  memberQuery: Pick<MemberQueryHelpers, 'listAllMembers'>,
): TeamCrudHelpers {
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
    const members = memberQuery.listAllMembers(teamId);
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

  function archive(
    teamId: string,
    opts?: { reason?: AgentDeckTeamArchiveReason },
  ): AgentDeckTeam | null {
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
      db.prepare(
        `UPDATE agent_deck_teams SET archived_at = NULL, archive_reason = NULL WHERE id = ?`,
      ).run(teamId);
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
  };
}
