/**
 * v034 migration 单测 — sessions list filter composite indexes.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

type SchemaVersion = 'pre-v034' | 'post-v034';

const EXPECTED_INDEX_COLUMNS: Record<string, string[]> = {
  idx_sessions_live_lifecycle_agent_last_event: ['lifecycle', 'agent_id', 'last_event_at'],
  idx_sessions_live_lifecycle_spawned_last_event: ['lifecycle', 'spawned_by', 'last_event_at'],
  idx_sessions_live_lifecycle_spawned_agent_last_event: [
    'lifecycle',
    'spawned_by',
    'agent_id',
    'last_event_at',
  ],
  idx_sessions_history_agent_last_event: ['agent_id', 'last_event_at'],
  idx_sessions_history_spawned_last_event: ['spawned_by', 'last_event_at'],
  idx_sessions_history_spawned_agent_last_event: ['spawned_by', 'agent_id', 'last_event_at'],
};

function makeDbAt(version: SchemaVersion): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (version === 'pre-v034' && migration.version >= 34) break;
    db.exec(migration.sql);
  }
  return db;
}

function indexNames(db: Database.Database): Set<string> {
  const rows = db.prepare(`PRAGMA index_list('sessions')`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function indexColumns(db: Database.Database, indexName: string): string[] {
  const escapedIndexName = indexName.replace(/'/g, "''");
  const rows = db
    .prepare(`PRAGMA index_info('${escapedIndexName}')`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function insertSession(db: Database.Database, id: string, spawnedBy: string | null = null): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
      spawned_by, spawn_depth)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', 'active', 'idle', 1000, 1000, ?, ?)`,
  ).run(id, `title-${id}`, spawnedBy, spawnedBy === null ? 0 : 1);
}

describe.skipIf(!bindingAvailable)('v034 migration / sessions list filter indexes', () => {
  it('post-v034 schema has the list_sessions filter indexes', () => {
    const db = makeDbAt('post-v034');
    try {
      const names = indexNames(db);
      for (const [indexName, expectedColumns] of Object.entries(EXPECTED_INDEX_COLUMNS)) {
        expect(names.has(indexName)).toBe(true);
        expect(indexColumns(db, indexName)).toEqual(expectedColumns);
      }
    } finally {
      db.close();
    }
  });

  it('v033 to v034 upgrade creates indexes without changing sessions', () => {
    const db = makeDbAt('pre-v034');
    try {
      insertSession(db, 'lead');
      insertSession(db, 's1', 'lead');
      const v034 = MIGRATIONS.find((migration) => migration.version === 34);
      expect(v034).toBeDefined();
      db.exec(v034!.sql);

      expect(indexNames(db).has('idx_sessions_live_lifecycle_spawned_agent_last_event')).toBe(
        true,
      );
      const row = db.prepare(`SELECT spawned_by, agent_id FROM sessions WHERE id = 's1'`).get() as {
        spawned_by: string;
        agent_id: string;
      };
      expect(row).toEqual({ spawned_by: 'lead', agent_id: 'codex-cli' });
    } finally {
      db.close();
    }
  });
});
