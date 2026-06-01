/**
 * v027 migration 单测（plan teamless-dm-20260601）— agent_deck_messages.team_id NOT NULL → nullable。
 *
 * 验 v027 行为（rename-old-first 重建自引用 FK 表，详 spike1-migration-self-ref-fk.md）：
 *
 * **sub-case A**: 新建 db post-v027 → 验:
 *   - team_id 列可空（INSERT team_id=NULL 成功）
 *   - 自引用 FK reply_to_message_id 仍 enforce（指向不存在 msg 被拒）
 *   - body CHECK / status CHECK / DEFAULT 全保留（byte-level 照搬 v010）
 *   - 5 个 index 全在
 *
 * **sub-case B**: v026→v027 跨版本升级 path，模拟真用户升级（**核心风险点**）:
 *   - applyMigrations(PRE_V027) 落老 schema（team_id NOT NULL）
 *   - seed fixture: team + 普通 msg + 多级 reply chain（m2→m1, m3→m2）+ 各状态/attempt
 *   - applyMigrations([v027]) 升级
 *   - **关键断言: 所有 reply_to_message_id 保留**（v017-style 朴素重建会静默 null 掉 → 本 test 抓）
 *   - 验: 全部 status / attempt_count / 普通列保留
 *   - 验: 升级后 team_id=NULL teamless insert 成功
 *   - 验: team CASCADE 仍工作 + teamless 行不受波及
 *
 * 走 in-memory better-sqlite3 真跑迁移 SQL（harness 照搬 v025-migration.test.ts）。
 * binding 守门: bindingAvailable=false（用错 runtime ABI）时整 describe skip + loud warn。
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
import v025 from '../migrations/v025_events_tool_use_end_dedup.sql?raw';
import v026 from '../migrations/v026_issues.sql?raw';
import v027 from '../migrations/v027_agent_deck_messages_team_id_nullable.sql?raw';

import { bindingAvailable } from './_binding-probe';

const PRE_V027 = [
  v001, v002, v003, v004, v005, v006, v007, v008, v009, v010, v011, v012,
  v013, v014, v015, v016, v017, v018, v019, v020, v021, v022, v023, v024,
  v025, v026,
];

function makeDbAt(version: 'pre-v027' | 'post-v027'): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of PRE_V027) db.exec(sql);
  if (version === 'post-v027') db.exec(v027);
  return db;
}

function seedTeam(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO agent_deck_teams (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, name, 1000);
}

function seedMessage(
  db: Database.Database,
  m: {
    id: string;
    teamId: string | null;
    from: string;
    to: string;
    body?: string;
    status?: string;
    statusReason?: string | null;
    attemptCount?: number;
    replyTo?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO agent_deck_messages
     (id, team_id, from_session_id, to_session_id, body, status, status_reason,
      sent_at, attempt_count, reply_to_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    m.teamId,
    m.from,
    m.to,
    m.body ?? 'body',
    m.status ?? 'pending',
    m.statusReason ?? null,
    1000,
    m.attemptCount ?? 0,
    m.replyTo ?? null,
  );
}

// ─── sub-case A: post-v027 schema 形态 ───────────────────────────────────────
describe.skipIf(!bindingAvailable)('v027 migration / sub-case A: post-v027 schema', () => {
  it('team_id 列可空（teamless DM insert team_id=NULL 成功）', () => {
    const db = makeDbAt('post-v027');
    try {
      db.prepare(
        `INSERT INTO agent_deck_messages (id, team_id, from_session_id, to_session_id, body, sent_at)
         VALUES ('dm1', NULL, 'sA', 'sB', 'teamless', 1000)`,
      ).run();
      const row = db
        .prepare(`SELECT team_id FROM agent_deck_messages WHERE id = 'dm1'`)
        .get() as { team_id: string | null };
      expect(row.team_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('自引用 FK reply_to_message_id 仍 enforce（指向不存在 msg 被拒）', () => {
    const db = makeDbAt('post-v027');
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO agent_deck_messages (id, team_id, from_session_id, to_session_id, body, sent_at, reply_to_message_id)
             VALUES ('bad', NULL, 'sA', 'sB', 'x', 1000, 'ghost')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it('body CHECK(length<=102400) / status CHECK / DEFAULT 全保留（byte-level 照搬 v010）', () => {
    const db = makeDbAt('post-v027');
    try {
      // body 超长被拒
      expect(() =>
        db
          .prepare(
            `INSERT INTO agent_deck_messages (id, team_id, from_session_id, to_session_id, body, sent_at)
             VALUES ('bigbody', NULL, 'sA', 'sB', ?, 1000)`,
          )
          .run('x'.repeat(102401)),
      ).toThrow(/CHECK constraint failed/);
      // status 非法枚举被拒
      expect(() =>
        db
          .prepare(
            `INSERT INTO agent_deck_messages (id, team_id, from_session_id, to_session_id, body, status, sent_at)
             VALUES ('badstatus', NULL, 'sA', 'sB', 'x', 'bogus', 1000)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      // DEFAULT 生效（不传 status → pending；不传 attempt_count → 0）
      db.prepare(
        `INSERT INTO agent_deck_messages (id, team_id, from_session_id, to_session_id, body, sent_at)
         VALUES ('def', NULL, 'sA', 'sB', 'x', 1000)`,
      ).run();
      const row = db
        .prepare(`SELECT status, attempt_count FROM agent_deck_messages WHERE id = 'def'`)
        .get() as { status: string; attempt_count: number };
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('5 个 idx_messages* index 全在', () => {
    const db = makeDbAt('post-v027');
    try {
      const rows = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_deck_messages' AND name LIKE 'idx_messages%'`,
        )
        .all() as { name: string }[];
      expect(rows).toHaveLength(5);
    } finally {
      db.close();
    }
  });
});

// ─── sub-case B: v026→v027 升级 path（核心风险：reply chain 不丢） ────────────
describe.skipIf(!bindingAvailable)('v027 migration / sub-case B: upgrade preserves reply chain', () => {
  it('升级保留多级 reply chain（v017-style 朴素重建会静默 null 掉 → 本断言抓）', () => {
    const db = makeDbAt('pre-v027');
    try {
      seedTeam(db, 't1', 'team-a');
      seedMessage(db, { id: 'm1', teamId: 't1', from: 's1', to: 's2', status: 'delivered' });
      seedMessage(db, { id: 'm2', teamId: 't1', from: 's2', to: 's1', status: 'pending', attemptCount: 2, replyTo: 'm1' });
      seedMessage(db, { id: 'm3', teamId: 't1', from: 's1', to: 's2', status: 'failed', statusReason: 'exhausted', attemptCount: 3, replyTo: 'm2' });

      db.exec(v027); // 升级

      const m2 = db.prepare(`SELECT reply_to_message_id FROM agent_deck_messages WHERE id = 'm2'`).get() as { reply_to_message_id: string | null };
      const m3 = db.prepare(`SELECT reply_to_message_id FROM agent_deck_messages WHERE id = 'm3'`).get() as { reply_to_message_id: string | null };
      // 核心：reply chain 完整保留（spike CASE-A 实证朴素重建会变 NULL）
      expect(m2.reply_to_message_id).toBe('m1');
      expect(m3.reply_to_message_id).toBe('m2');

      // foreign_key_check 干净
      const viol = db.prepare(`PRAGMA foreign_key_check`).all();
      expect(viol).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('升级保留全部 status / attempt_count / 普通列', () => {
    const db = makeDbAt('pre-v027');
    try {
      seedTeam(db, 't1', 'team-a');
      seedMessage(db, { id: 'm1', teamId: 't1', from: 's1', to: 's2', status: 'delivered' });
      seedMessage(db, { id: 'm3', teamId: 't1', from: 's1', to: 's2', status: 'failed', statusReason: 'exhausted', attemptCount: 3 });

      db.exec(v027);

      const m1 = db.prepare(`SELECT status FROM agent_deck_messages WHERE id = 'm1'`).get() as { status: string };
      const m3 = db.prepare(`SELECT status, status_reason, attempt_count FROM agent_deck_messages WHERE id = 'm3'`).get() as { status: string; status_reason: string; attempt_count: number };
      expect(m1.status).toBe('delivered');
      expect(m3.status).toBe('failed');
      expect(m3.status_reason).toBe('exhausted');
      expect(m3.attempt_count).toBe(3);
    } finally {
      db.close();
    }
  });

  it('升级后 teamless insert 成功 + team CASCADE 仍工作 + teamless 行不受 CASCADE 波及', () => {
    const db = makeDbAt('pre-v027');
    try {
      seedTeam(db, 't1', 'team-a');
      seedMessage(db, { id: 'm1', teamId: 't1', from: 's1', to: 's2' });

      db.exec(v027);

      // teamless insert（升级后能力）
      db.prepare(
        `INSERT INTO agent_deck_messages (id, team_id, from_session_id, to_session_id, body, sent_at)
         VALUES ('dm1', NULL, 'sA', 'sB', 'teamless', 2000)`,
      ).run();
      expect((db.prepare(`SELECT team_id FROM agent_deck_messages WHERE id = 'dm1'`).get() as { team_id: string | null }).team_id).toBeNull();

      // team CASCADE：删 team → 该 team 消息级联删
      db.prepare(`DELETE FROM agent_deck_teams WHERE id = 't1'`).run();
      expect(db.prepare(`SELECT count(*) AS c FROM agent_deck_messages WHERE team_id = 't1'`).get()).toEqual({ c: 0 });
      // teamless 行不受 team CASCADE 波及
      expect(db.prepare(`SELECT count(*) AS c FROM agent_deck_messages WHERE id = 'dm1'`).get()).toEqual({ c: 1 });
    } finally {
      db.close();
    }
  });
});
