/**
 * v032 migration 单测 — sessions 表加 thinking TEXT。
 *
 * 覆盖：
 * - post-v032 schema 可写 thinking，rowToRecord 投影到 SessionRecord.thinking
 * - v031→v032 升级后老 session thinking 默认 NULL
 * - rename(fromId,toId) 两条路径会保留 OLD session 的 thinking
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';
import { rowToRecord, type Row } from '../session-repo/types';
import { renameWithDb } from '../session-repo/rename';

type SchemaVersion = 'pre-v032' | 'post-v032';

function makeDbAt(version: SchemaVersion): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (version === 'pre-v032' && migration.version >= 32) break;
    db.exec(migration.sql);
  }
  return db;
}

function insertBaseSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', '/tmp/repo', ?, 'sdk', 'active', 'idle', 1000, 1000)`,
  ).run(id, `title-${id}`);
}

function insertSessionWithThinking(
  db: Database.Database,
  id: string,
  thinking: string | null,
): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, thinking)
     VALUES (?, 'codex-cli', '/tmp/repo', ?, 'sdk', 'active', 'idle', 1000, 1000, ?)`,
  ).run(id, `title-${id}`, thinking);
}

function getRow(db: Database.Database, id: string): Row {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row;
}

describe.skipIf(!bindingAvailable)('v032 migration / sessions.thinking', () => {
  it('post-v032 schema can write thinking and rowToRecord projects it', () => {
    const db = makeDbAt('post-v032');
    try {
      insertSessionWithThinking(db, 's-high', 'high');

      const row = getRow(db, 's-high');
      expect(row.thinking).toBe('high');
      expect(rowToRecord(row).thinking).toBe('high');
    } finally {
      db.close();
    }
  });

  it('post-v032 rows without thinking keep NULL/default semantics', () => {
    const db = makeDbAt('post-v032');
    try {
      insertBaseSession(db, 's-default');

      const row = getRow(db, 's-default');
      expect(row.thinking).toBeNull();
      expect(rowToRecord(row).thinking).toBeNull();
    } finally {
      db.close();
    }
  });

  it('v031 to v032 upgrade leaves old sessions thinking NULL', () => {
    const db = makeDbAt('pre-v032');
    try {
      insertBaseSession(db, 's-old');
      const v032 = MIGRATIONS.find((migration) => migration.version === 32);
      expect(v032).toBeDefined();
      db.exec(v032!.sql);

      const row = getRow(db, 's-old');
      expect(row.thinking).toBeNull();
      expect(rowToRecord(row).thinking).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rename toExists=false copies thinking to the new session row', () => {
    const db = makeDbAt('post-v032');
    try {
      insertSessionWithThinking(db, 'sid-OLD', 'xhigh');

      renameWithDb(db, 'sid-OLD', 'sid-NEW');

      expect(db.prepare(`SELECT 1 FROM sessions WHERE id = 'sid-OLD'`).get()).toBeUndefined();
      expect(rowToRecord(getRow(db, 'sid-NEW')).thinking).toBe('xhigh');
    } finally {
      db.close();
    }
  });

  it('rename toExists=true preserves OLD thinking over NEW row defaults', () => {
    const db = makeDbAt('post-v032');
    try {
      insertSessionWithThinking(db, 'sid-OLD', 'max');
      insertSessionWithThinking(db, 'sid-NEW', 'low');

      renameWithDb(db, 'sid-OLD', 'sid-NEW');

      expect(db.prepare(`SELECT 1 FROM sessions WHERE id = 'sid-OLD'`).get()).toBeUndefined();
      expect(rowToRecord(getRow(db, 'sid-NEW')).thinking).toBe('max');
    } finally {
      db.close();
    }
  });
});
