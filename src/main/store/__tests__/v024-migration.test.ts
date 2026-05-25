/**
 * v024 migration 单测（plan task-team-id-restore-20260525 Phase G Step G1）。
 *
 * 验 v024 ALTER TABLE ADD COLUMN team_id 行为 + v023→v024 跨版本升级 path:
 *
 * **sub-case A**: 新建 db post-v024 → 验:
 *   - tasks.team_id 列就位（PRAGMA table_info）
 *   - team_id 默认值 NULL，nullable
 *   - idx_tasks_team_id 部分索引就位（partial WHERE team_id IS NOT NULL）
 *   - FK ON DELETE SET NULL constraint 注册（PRAGMA foreign_key_list）
 *   - team hard delete → owner task team_id 自动 SET NULL（不级联删 task）
 *
 * **sub-case B**(MED-5 修法): v023→v024 跨版本 fixture 模拟真用户升级 path:
 *   - applyMigrations(['001'...'v023']) 落老 schema（无 team_id 列）
 *   - seed v023 fixture data: caller session + N 个 task 行无 team_id
 *   - applyMigrations(['v024']) 升级
 *   - 验:老 task 自动 team_id IS NULL（变 personal task）+ 数据零丢失 + 列名/列数对齐
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import v001 from '../migrations/v001_init.sql?raw';
import v002 from '../migrations/v002_sessions_source.sql?raw';
import v003 from '../migrations/v003_split_archive_from_lifecycle.sql?raw';
import v004 from '../migrations/v004_sessions_permission_mode.sql?raw';
import v005 from '../migrations/v005_fts.sql?raw';
import v006 from '../migrations/v006_sessions_team_name.sql?raw';
import v007 from '../migrations/v007_tasks.sql?raw';
import v008 from '../migrations/v008_sessions_codex_sandbox.sql?raw';
import v009 from '../migrations/v009_mcp_spawn_chain.sql?raw';
import v010 from '../migrations/v010_agent_deck_teams.sql?raw';
import v011 from '../migrations/v011_tasks_team_id.sql?raw';
import v012 from '../migrations/v012_sessions_generic_pty_config.sql?raw';
import v013 from '../migrations/v013_sessions_claude_code_sandbox.sql?raw';
import v014 from '../migrations/v014_drop_sessions_team_name.sql?raw';
import v015 from '../migrations/v015_agent_deck_messages_reply_to.sql?raw';
import v016 from '../migrations/v016_agent_deck_teams_archive_reason.sql?raw';
import v017 from '../migrations/v017_agent_deck_team_members_cascade.sql?raw';
import v018 from '../migrations/v018_sessions_model.sql?raw';
import v019 from '../migrations/v019_sessions_extra_allow_write.sql?raw';
import v020 from '../migrations/v020_sessions_cwd_release_marker.sql?raw';
import v021 from '../migrations/v021_sessions_cli_session_id.sql?raw';
import v022 from '../migrations/v022_events_tool_use_dedup.sql?raw';
import v023 from '../migrations/v023_tasks_owner_session_id_rewrite.sql?raw';
import v024 from '../migrations/v024_tasks_add_team_id.sql?raw';

const PRE_V024 = [
  v001, v002, v003, v004, v005, v006, v007, v008, v009, v010, v011, v012,
  v013, v014, v015, v016, v017, v018, v019, v020, v021, v022, v023,
];

function probeBetterSqliteBinding(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch (e) {
    console.warn(
      `[v024-migration.test] better-sqlite3 binding 不可用，跳过本文件全部用例。原因：${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
const bindingAvailable = probeBetterSqliteBinding();

function makeDbAt(version: 'pre-v024' | 'post-v024'): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of PRE_V024) db.exec(sql);
  if (version === 'post-v024') db.exec(v024);
  return db;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', '/tmp', ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, `title-${id}`, 1000, 1000);
}

function insertTeam(db: Database.Database, id: string, name = `team-${id}`): void {
  db.prepare(
    `INSERT INTO agent_deck_teams (id, name, created_at, archived_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(id, name, 1000);
}

describe.skipIf(!bindingAvailable)('v024 migration / sub-case A: ALTER TABLE ADD COLUMN', () => {
  it('CREATE TABLE：tasks 表加 team_id 列就位', () => {
    const db = makeDbAt('post-v024');
    try {
      const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const colNames = cols.map((c) => c.name).sort();
      // v023 12 列 + v024 加 team_id = 13 列
      expect(colNames).toEqual(
        [
          'id',
          'owner_session_id',
          'team_id', // v024 新增
          'subject',
          'description',
          'status',
          'active_form',
          'priority',
          'blocks',
          'blocked_by',
          'labels',
          'created_at',
          'updated_at',
        ].sort(),
      );

      // team_id NULLABLE
      const teamCol = cols.find((c) => c.name === 'team_id');
      expect(teamCol).toBeDefined();
      expect(teamCol?.notnull).toBe(0); // NULL 允许（plan §D1）
      expect(teamCol?.dflt_value).toBeNull(); // 默认无 default value（自动 NULL）
    } finally {
      db.close();
    }
  });

  it('CREATE INDEX：idx_tasks_team_id 部分索引就位（WHERE team_id IS NOT NULL）', () => {
    const db = makeDbAt('post-v024');
    try {
      const indexes = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`)
        .all() as Array<{ name: string; sql: string | null }>;
      const teamIdx = indexes.find((i) => i.name === 'idx_tasks_team_id');
      expect(teamIdx).toBeDefined();
      // v024 SQL 要求 partial index `WHERE team_id IS NOT NULL`
      expect(teamIdx?.sql).toContain('WHERE');
      expect(teamIdx?.sql).toContain('team_id IS NOT NULL');
    } finally {
      db.close();
    }
  });

  it('FK 约束：tasks.team_id 指向 agent_deck_teams(id) ON DELETE SET NULL（PRAGMA foreign_key_list）', () => {
    const db = makeDbAt('post-v024');
    try {
      const fks = db.prepare(`PRAGMA foreign_key_list(tasks)`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>;
      const teamFk = fks.find((f) => f.from === 'team_id');
      expect(teamFk).toBeDefined();
      expect(teamFk?.table).toBe('agent_deck_teams');
      expect(teamFk?.to).toBe('id');
      expect(teamFk?.on_delete).toBe('SET NULL');
    } finally {
      db.close();
    }
  });

  it('FK ON DELETE SET NULL：team hard delete → owner task team_id 自动 SET NULL（不级联删 task — plan §不变量 4 GC 兜底）', () => {
    const db = makeDbAt('post-v024');
    try {
      insertSession(db, 'sess-X');
      insertTeam(db, 'team-A');

      // 插 2 条 team-bound task + 1 条 personal task
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, team_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('t-1', 'sess-X', 'team-A', 'team task 1', '2025-01-01', '2025-01-01');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, team_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('t-2', 'sess-X', 'team-A', 'team task 2', '2025-01-01', '2025-01-01');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, team_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('t-3', 'sess-X', null, 'personal task', '2025-01-01', '2025-01-01');

      // hard delete team-A
      db.prepare(`DELETE FROM agent_deck_teams WHERE id = ?`).run('team-A');

      // 3 条 task 都还在（不级联删）
      const all = db
        .prepare(`SELECT id, owner_session_id, team_id FROM tasks ORDER BY id`)
        .all() as Array<{ id: string; owner_session_id: string; team_id: string | null }>;
      expect(all).toHaveLength(3);
      // t-1 / t-2 team_id 自动 SET NULL（退化 personal）
      expect(all[0]).toEqual({ id: 't-1', owner_session_id: 'sess-X', team_id: null });
      expect(all[1]).toEqual({ id: 't-2', owner_session_id: 'sess-X', team_id: null });
      // t-3 本来就是 personal,不动
      expect(all[2]).toEqual({ id: 't-3', owner_session_id: 'sess-X', team_id: null });
    } finally {
      db.close();
    }
  });

  it('插 team task：team_id 必须指向真实存在的 team（FK 约束）', () => {
    const db = makeDbAt('post-v024');
    try {
      insertSession(db, 'sess-X');
      // 不存在的 team_id → INSERT 失败（FK 约束）
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (id, owner_session_id, team_id, subject, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run('t-1', 'sess-X', 'team-not-exist', 'X', '2025-01-01', '2025-01-01'),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('插 personal task：team_id 不传 / 显式 NULL 都合法', () => {
    const db = makeDbAt('post-v024');
    try {
      insertSession(db, 'sess-X');
      // team_id 显式 null
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, team_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('t-1', 'sess-X', null, 'X1', '2025-01-01', '2025-01-01');
      // team_id 不传（依赖默认 null）
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('t-2', 'sess-X', 'X2', '2025-01-01', '2025-01-01');

      const rows = db
        .prepare(`SELECT id, team_id FROM tasks ORDER BY id`)
        .all() as Array<{ id: string; team_id: string | null }>;
      expect(rows).toEqual([
        { id: 't-1', team_id: null },
        { id: 't-2', team_id: null },
      ]);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!bindingAvailable)('v024 migration / sub-case B: v023 → v024 跨版本升级 path（MED-5 修法）', () => {
  it('apply v001-v023 → seed 老 task 数据(无 team_id 列)→ apply v024 → 老 task 自动 team_id IS NULL（数据零丢失）', () => {
    // 模拟真用户升级 path：先有 v023 schema 跑业务一段时间，然后应用升级到 v024
    const db = makeDbAt('pre-v024'); // 跑 v001-v023
    try {
      insertSession(db, 'sess-A');
      insertSession(db, 'sess-B');

      // pre-v024 时 tasks 表没有 team_id 列 — 验证一下
      const colsPre = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      expect(colsPre.map((c) => c.name)).not.toContain('team_id');

      // seed 5 条 v023 风格 task（无 team_id 列，全部 owner=sess-A 与 sess-B）
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, description, status, active_form, priority,
         blocks, blocked_by, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('old-1', 'sess-A', 'Old A1', 'desc-A1', 'active', 'doing', 7, '[]', '[]', '["old"]',
        '2025-01-01', '2025-01-02');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, status, priority, blocks, blocked_by, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('old-2', 'sess-A', 'Old A2', 'pending', 5, '[]', '[]', '[]', '2025-01-01', '2025-01-02');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, status, priority, blocks, blocked_by, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('old-3', 'sess-B', 'Old B1', 'completed', 3, '[]', '[]', '[]', '2025-01-01', '2025-01-02');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, status, priority, blocks, blocked_by, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('old-4', 'sess-B', 'Old B2', 'pending', 5, '["old-3"]', '[]', '[]', '2025-01-01', '2025-01-02');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, status, priority, blocks, blocked_by, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('old-5', 'sess-B', 'Old B3', 'pending', 5, '[]', '["old-3"]', '[]', '2025-01-01', '2025-01-02');

      const beforeCount = (db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c;
      expect(beforeCount).toBe(5);

      // 应用升级到 v024
      db.exec(v024);

      // 列就位（含新 team_id）+ 数据零丢失
      const colsPost = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      expect(colsPost.map((c) => c.name)).toContain('team_id');

      const afterCount = (db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c;
      expect(afterCount).toBe(5);

      // 老 task 自动 team_id IS NULL（变 personal task — plan §D6 老数据自动兼容行为）
      const all = db
        .prepare(`SELECT id, owner_session_id, team_id, subject, status, priority, blocks, blocked_by, labels FROM tasks ORDER BY id`)
        .all() as Array<{
          id: string;
          owner_session_id: string;
          team_id: string | null;
          subject: string;
          status: string;
          priority: number;
          blocks: string;
          blocked_by: string;
          labels: string;
        }>;
      expect(all).toHaveLength(5);
      for (const r of all) {
        expect(r.team_id).toBeNull(); // 关键：所有老 task 都自动 personal
      }
      // 其他字段保留原值（数据零丢失）
      expect(all[0]).toMatchObject({
        id: 'old-1',
        owner_session_id: 'sess-A',
        subject: 'Old A1',
        status: 'active',
        priority: 7,
        labels: '["old"]',
      });
      expect(all[3]).toMatchObject({
        id: 'old-4',
        owner_session_id: 'sess-B',
        subject: 'Old B2',
        blocks: '["old-3"]',
      });
      expect(all[4]).toMatchObject({
        id: 'old-5',
        owner_session_id: 'sess-B',
        subject: 'Old B3',
        blocked_by: '["old-3"]',
      });
    } finally {
      db.close();
    }
  });

  it('升级后老 task 仍可 update / delete（v023 行为 forward-compat）', () => {
    const db = makeDbAt('pre-v024');
    try {
      insertSession(db, 'sess-A');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, status, priority, blocks, blocked_by, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('old-1', 'sess-A', 'Old', 'pending', 5, '[]', '[]', '[]', '2025-01-01', '2025-01-02');

      db.exec(v024);

      // 老 task 升级后可 update
      db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run('completed', 'old-1');
      expect(
        (db.prepare(`SELECT status FROM tasks WHERE id = ?`).get('old-1') as { status: string })
          .status,
      ).toBe('completed');

      // 老 task 升级后可 delete
      db.prepare(`DELETE FROM tasks WHERE id = ?`).run('old-1');
      expect(db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });

  it('升级后插入 team-bound task 与 personal task 都正常（forward-compat）', () => {
    const db = makeDbAt('pre-v024');
    try {
      insertSession(db, 'sess-A');
      // pre-upgrade seed 1 条老 task
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, status, priority, blocks, blocked_by, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('old-1', 'sess-A', 'Old', 'pending', 5, '[]', '[]', '[]', '2025-01-01', '2025-01-02');

      db.exec(v024);

      // 插 team
      insertTeam(db, 'team-X');

      // 升级后插 team-bound task
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, team_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('new-team', 'sess-A', 'team-X', 'team task', '2025-01-03', '2025-01-03');
      // 升级后插 personal task（team_id IS NULL）
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, team_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('new-personal', 'sess-A', null, 'personal task', '2025-01-03', '2025-01-03');

      const rows = db
        .prepare(`SELECT id, team_id FROM tasks ORDER BY id`)
        .all() as Array<{ id: string; team_id: string | null }>;
      expect(rows).toEqual([
        { id: 'new-personal', team_id: null },
        { id: 'new-team', team_id: 'team-X' },
        { id: 'old-1', team_id: null }, // 老 task 仍 NULL
      ]);
    } finally {
      db.close();
    }
  });
});
