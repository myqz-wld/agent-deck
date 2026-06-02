/**
 * v029 migration 单测（plan codex-recover-network-dirs-parity-20260602）—
 * sessions 表加 network_access_enabled INTEGER + additional_directories TEXT。
 *
 * v029 是纯 additive `ALTER TABLE ADD COLUMN`（无 v027 那种自引用 FK 表重建风险），覆盖：
 *
 * **sub-case A**: post-v029 schema 形态
 *   - 两列存在（INSERT 带这俩列成功）
 *   - 默认 NULL（不传这俩列的 INSERT → 读出 NULL，3 态 unset 语义）
 *
 * **sub-case B**: v028→v029 升级 path（老用户升级）
 *   - 升级前 seed 一行（无新列）→ 升级后该行两列为 NULL（老 session 不被污染，与 claude /
 *     普通 codex session 恒 NULL 不变量一致）
 *
 * **sub-case C**: rowToRecord int→bool 3 态 round-trip（**核心** — boolean-bind gotcha + 语义）
 *   - network_access_enabled 1 → true / 0 → false / NULL → null（不是误判 false）
 *   - additional_directories JSON round-trip + parseStringArrayJson 防脏（非法 JSON → null）
 *
 * 走 in-memory better-sqlite3 真跑迁移 SQL（harness 照搬 v027-migration.test.ts）。
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
import v028 from '../migrations/v028_token_usage.sql?raw';
import v029 from '../migrations/v029_sessions_network_dirs.sql?raw';

import { bindingAvailable } from './_binding-probe';
import { rowToRecord, type Row } from '../session-repo/types';

const PRE_V029 = [
  v001, v002, v003, v004, v005, v006, v007, v008, v009, v010, v011, v012,
  v013, v014, v015, v016, v017, v018, v019, v020, v021, v022, v023, v024,
  v025, v026, v027, v028,
];

function makeDbAt(version: 'pre-v029' | 'post-v029'): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of PRE_V029) db.exec(sql);
  if (version === 'post-v029') db.exec(v029);
  return db;
}

function insertSessionRow(
  db: Database.Database,
  id: string,
  cols?: { networkAccessEnabled?: number | null; additionalDirectories?: string | null },
): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
      network_access_enabled, additional_directories)
     VALUES (?, 'codex-cli', '/tmp', ?, 'sdk', 'active', 'idle', 1000, 1000, ?, ?)`,
  ).run(
    id,
    `title-${id}`,
    cols?.networkAccessEnabled ?? null,
    cols?.additionalDirectories ?? null,
  );
}

/** 取一整行 sessions（带 v029 列）转 Row 形态喂 rowToRecord。 */
function getRow(db: Database.Database, id: string): Row {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row;
}

// ─── sub-case A: post-v029 schema 形态 ───────────────────────────────────────
describe.skipIf(!bindingAvailable)('v029 migration / sub-case A: post-v029 schema', () => {
  it('两列存在（INSERT 带 network_access_enabled + additional_directories 成功）', () => {
    const db = makeDbAt('post-v029');
    try {
      insertSessionRow(db, 's1', {
        networkAccessEnabled: 1,
        additionalDirectories: JSON.stringify(['/a', '/b']),
      });
      const row = getRow(db, 's1');
      expect(row.network_access_enabled).toBe(1);
      expect(row.additional_directories).toBe(JSON.stringify(['/a', '/b']));
    } finally {
      db.close();
    }
  });

  it('不传这俩列 → 默认 NULL（3 态 unset 语义）', () => {
    const db = makeDbAt('post-v029');
    try {
      db.prepare(
        `INSERT INTO sessions (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('s2', 'claude-code', '/tmp', 't', 'sdk', 'active', 'idle', 1000, 1000)`,
      ).run();
      const row = getRow(db, 's2');
      expect(row.network_access_enabled).toBeNull();
      expect(row.additional_directories).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ─── sub-case B: v028→v029 升级 path（老 session 不被污染） ────────────────────
describe.skipIf(!bindingAvailable)('v029 migration / sub-case B: upgrade leaves old rows NULL', () => {
  it('升级前 seed 的老行 → 升级后两列为 NULL（claude / 普通 codex 恒 NULL 不变量）', () => {
    const db = makeDbAt('pre-v029');
    try {
      db.prepare(
        `INSERT INTO sessions (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('old1', 'codex-cli', '/tmp', 't', 'sdk', 'active', 'idle', 1000, 1000)`,
      ).run();

      db.exec(v029); // 升级

      const row = getRow(db, 'old1');
      expect(row.network_access_enabled).toBeNull();
      expect(row.additional_directories).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ─── sub-case C: rowToRecord int→bool 3 态 round-trip（核心 — boolean-bind gotcha） ──
describe.skipIf(!bindingAvailable)('v029 migration / sub-case C: rowToRecord int→bool 3 态', () => {
  it('network_access_enabled 1 → true', () => {
    const db = makeDbAt('post-v029');
    try {
      insertSessionRow(db, 's-true', { networkAccessEnabled: 1 });
      expect(rowToRecord(getRow(db, 's-true')).networkAccessEnabled).toBe(true);
    } finally {
      db.close();
    }
  });

  it('network_access_enabled 0 → false（不是 null — 显式 false 与 unset 区分）', () => {
    const db = makeDbAt('post-v029');
    try {
      insertSessionRow(db, 's-false', { networkAccessEnabled: 0 });
      expect(rowToRecord(getRow(db, 's-false')).networkAccessEnabled).toBe(false);
    } finally {
      db.close();
    }
  });

  it('network_access_enabled NULL → null（不是误判 false）', () => {
    const db = makeDbAt('post-v029');
    try {
      insertSessionRow(db, 's-null', { networkAccessEnabled: null });
      expect(rowToRecord(getRow(db, 's-null')).networkAccessEnabled).toBeNull();
    } finally {
      db.close();
    }
  });

  it('additional_directories JSON round-trip → string[]', () => {
    const db = makeDbAt('post-v029');
    try {
      insertSessionRow(db, 's-dirs', {
        additionalDirectories: JSON.stringify(['/home/.claude', '/home/.codex', '/tmp']),
      });
      expect(rowToRecord(getRow(db, 's-dirs')).additionalDirectories).toEqual([
        '/home/.claude',
        '/home/.codex',
        '/tmp',
      ]);
    } finally {
      db.close();
    }
  });

  it('additional_directories NULL → null', () => {
    const db = makeDbAt('post-v029');
    try {
      insertSessionRow(db, 's-dirs-null', { additionalDirectories: null });
      expect(rowToRecord(getRow(db, 's-dirs-null')).additionalDirectories).toBeNull();
    } finally {
      db.close();
    }
  });

  it('additional_directories 非法 JSON / 空数组 → null（parseStringArrayJson 防脏）', () => {
    const db = makeDbAt('post-v029');
    try {
      insertSessionRow(db, 's-bad', { additionalDirectories: 'not json{' });
      expect(rowToRecord(getRow(db, 's-bad')).additionalDirectories).toBeNull();
      insertSessionRow(db, 's-empty', { additionalDirectories: JSON.stringify([]) });
      expect(rowToRecord(getRow(db, 's-empty')).additionalDirectories).toBeNull();
    } finally {
      db.close();
    }
  });
});
