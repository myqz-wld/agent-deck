/**
 * v023 migration 单测（plan task-mcp-owner-session-id-rewrite-20260521 Step 1+10）。
 *
 * 验 v023 的 DROP TABLE + CREATE TABLE 全新 schema 行为：
 * - 跑完 v001-v022（含 v007/v011 老 schema）+ 插入 5 条老 task → v023 跑完老数据被清
 * - 新 schema 列：owner_session_id NOT NULL FK → sessions(id) ON DELETE CASCADE
 * - 索引：idx_tasks_owner_session_id / idx_tasks_status / idx_tasks_updated_at
 * - FK ON DELETE CASCADE 触发：删 sessions row → task 自动删
 * - team_name / team_id 列彻底消失（pragma table_info 验列名清单）
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

const PRE_V023 = [
  v001, v002, v003, v004, v005, v006, v007, v008, v009, v010, v011, v012,
  v013, v014, v015, v016, v017, v018, v019, v020, v021, v022,
];

import { bindingAvailable } from './_binding-probe';

function makeDbAt(version: 'pre-v023' | 'post-v023'): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of PRE_V023) db.exec(sql);
  if (version === 'post-v023') db.exec(v023);
  return db;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', '/tmp', ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, `title-${id}`, 1000, 1000);
}

describe.skipIf(!bindingAvailable)('v023 migration / DROP + CREATE 全新 schema', () => {
  it('DROP TABLE：v022 状态下插入老 task → v023 跑完全清', () => {
    const db = makeDbAt('pre-v023');
    try {
      insertSession(db, 'sess-1');
      // 插 5 条老 task（v007/v011 schema：含 team_name / team_id 字段）
      for (let i = 0; i < 5; i += 1) {
        db.prepare(
          `INSERT INTO tasks
           (id, team_name, team_id, subject, status, priority, blocks, blocked_by, labels, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 5, '[]', '[]', '[]', ?, ?)`,
        ).run(`old-${i}`, 'team-X', null, `S${i}`, '2025-01-01', '2025-01-01');
      }
      const beforeCount = (db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c;
      expect(beforeCount).toBe(5);

      // 跑 v023：DROP TABLE + CREATE TABLE
      db.exec(v023);

      const afterCount = (db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c;
      expect(afterCount).toBe(0); // 老数据全清
    } finally {
      db.close();
    }
  });

  it('CREATE TABLE：tasks 表新 schema 字段就位', () => {
    const db = makeDbAt('post-v023');
    try {
      const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const colNames = cols.map((c) => c.name).sort();
      expect(colNames).toEqual(
        [
          'id',
          'owner_session_id',
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

      // owner_session_id NOT NULL
      const ownerCol = cols.find((c) => c.name === 'owner_session_id');
      expect(ownerCol?.notnull).toBe(1);

      // team_name / team_id 列彻底消失
      expect(colNames).not.toContain('team_name');
      expect(colNames).not.toContain('team_id');
    } finally {
      db.close();
    }
  });

  it('CREATE INDEX：3 个 index 都建好', () => {
    const db = makeDbAt('post-v023');
    try {
      const indexes = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`)
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_tasks_owner_session_id');
      expect(indexNames).toContain('idx_tasks_status');
      expect(indexNames).toContain('idx_tasks_updated_at');
      // 老索引（v007 idx_tasks_team_name / v011 idx_tasks_team_id）不应出现
      expect(indexNames).not.toContain('idx_tasks_team_name');
      expect(indexNames).not.toContain('idx_tasks_team_id');
    } finally {
      db.close();
    }
  });

  it('FK 约束：owner_session_id 指向不存在的 session → INSERT 失败', () => {
    const db = makeDbAt('post-v023');
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks
             (id, owner_session_id, subject, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run('t-1', 'sess-not-exist', 'X', '2025-01-01', '2025-01-01'),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('FK ON DELETE CASCADE：删 session → task 自动删（plan §D4 GC 路径）', () => {
    const db = makeDbAt('post-v023');
    try {
      insertSession(db, 'sess-X');
      insertSession(db, 'sess-Y');
      db.prepare(
        `INSERT INTO tasks
         (id, owner_session_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('t-1', 'sess-X', 'X1', '2025-01-01', '2025-01-01');
      db.prepare(
        `INSERT INTO tasks
         (id, owner_session_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('t-2', 'sess-X', 'X2', '2025-01-01', '2025-01-01');
      db.prepare(
        `INSERT INTO tasks
         (id, owner_session_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('t-3', 'sess-Y', 'Y1', '2025-01-01', '2025-01-01');

      db.prepare(`DELETE FROM sessions WHERE id = ?`).run('sess-X');

      const remaining = db.prepare(`SELECT id, owner_session_id FROM tasks`).all() as Array<{
        id: string;
        owner_session_id: string;
      }>;
      // sess-X 的 t-1, t-2 全 CASCADE 删；sess-Y 的 t-3 留
      expect(remaining).toEqual([{ id: 't-3', owner_session_id: 'sess-Y' }]);
    } finally {
      db.close();
    }
  });

  it('NOT NULL 约束：owner_session_id 缺失 → INSERT 失败', () => {
    const db = makeDbAt('post-v023');
    try {
      insertSession(db, 'sess-X');
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks
             (id, subject, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run('t-1', 'X', '2025-01-01', '2025-01-01'),
      ).toThrow(/NOT NULL/i);
    } finally {
      db.close();
    }
  });

  it('重复执行匹配 destructive DROP+CREATE 契约（不抛 + 重建空表，非数据幂等）', () => {
    const db = makeDbAt('post-v023');
    try {
      // v023 = `DROP TABLE IF EXISTS tasks` + `CREATE TABLE tasks`（SQL:34,61）。重跑不是
      // **数据**幂等（会清空有数据的 tasks），而是**契约**幂等：DROP IF EXISTS 兜底重跑不抛 +
      // schema 重建正确。先插一条 task，重跑 v023，显式断言被清空（明示 destructive rerun 语义）。
      insertSession(db, 'sess-1');
      db.prepare(
        `INSERT INTO tasks (id, owner_session_id, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('t-1', 'sess-1', 'X', '2025-01-01', '2025-01-01');
      expect((db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c).toBe(1);

      // 重跑 v023：DROP IF EXISTS 使其不抛（CREATE TABLE 无 IF NOT EXISTS 但前面已 DROP）
      expect(() => db.exec(v023)).not.toThrow();

      // destructive：原 task 被清空 + schema 仍正确（owner_session_id 列在）
      expect((db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c).toBe(0);
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain('owner_session_id');
    } finally {
      db.close();
    }
  });
});
