/**
 * v039 migration tests — persistent session pin state and pin-aware query indexes.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

const EXPECTED_INDEX_COLUMNS: Record<string, string[]> = {
  idx_sessions_unpinned_live_lifecycle_last_event: ['lifecycle', 'last_event_at'],
  idx_sessions_live_pinned_last_event: ['pinned_at', 'last_event_at', 'id'],
  idx_sessions_unpinned_history_last_event: ['last_event_at', 'id'],
};

function makeDbThrough(version: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
  return db;
}

function migrationV039(): string {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 39);
  expect(migration).toEqual(expect.objectContaining({ version: 39, name: 'sessions_pinned' }));
  return migration!.sql;
}

function insertSession(
  db: Database.Database,
  id: string,
  lifecycle: 'active' | 'dormant' | 'closed' = 'active',
  lastEventAt = 1000,
  archivedAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
        archived_at)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', ?, 'idle', 1000, ?, ?)`,
  ).run(id, `title-${id}`, lifecycle, lastEventAt, archivedAt);
}

function indexSql(db: Database.Database, name: string): string {
  return db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .pluck()
    .get(name) as string;
}

function indexColumns(db: Database.Database, name: string): string[] {
  const escapedName = name.replace(/'/g, "''");
  return (
    db.prepare(`PRAGMA index_info('${escapedName}')`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function explain(db: Database.Database, sql: string, ...params: unknown[]): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
  ).map((row) => row.detail);
}

describe.skipIf(!bindingAvailable)('v039 migration / session pinning', () => {
  it('is registered immediately after v038 and upgrades legacy rows as unpinned', () => {
    const v038Index = MIGRATIONS.findIndex((migration) => migration.version === 38);
    const v039Index = MIGRATIONS.findIndex((migration) => migration.version === 39);
    expect(v039Index).toBe(v038Index + 1);

    const db = makeDbThrough(38);
    try {
      insertSession(db, 'legacy-active');
      insertSession(db, 'legacy-closed', 'closed', 500);

      db.exec(migrationV039());

      const column = (
        db.prepare(`PRAGMA table_info('sessions')`).all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((candidate) => candidate.name === 'pinned_at');
      expect(column).toMatchObject({ name: 'pinned_at', notnull: 0, dflt_value: null });
      expect(db.prepare('SELECT id, pinned_at FROM sessions ORDER BY id').all()).toEqual([
        { id: 'legacy-active', pinned_at: null },
        { id: 'legacy-closed', pinned_at: null },
      ]);

      insertSession(db, 'created-after-v039');
      expect(
        db.prepare(`SELECT pinned_at FROM sessions WHERE id = 'created-after-v039'`).get(),
      ).toEqual({ pinned_at: null });
    } finally {
      db.close();
    }
  });

  it('fresh migration chain exposes the nullable column and only the three focused pin indexes', () => {
    const db = makeDbThrough(39);
    try {
      const columnNames = (
        db.prepare(`PRAGMA table_info('sessions')`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columnNames.at(-1)).toBe('pinned_at');

      const pinIndexNames = (
        db.prepare(`PRAGMA index_list('sessions')`).all() as Array<{ name: string }>
      )
        .map((row) => row.name)
        .filter((name) => name.includes('pinned'))
        .sort();
      expect(pinIndexNames).toEqual(Object.keys(EXPECTED_INDEX_COLUMNS).sort());
      for (const [name, columns] of Object.entries(EXPECTED_INDEX_COLUMNS)) {
        expect(indexColumns(db, name)).toEqual(columns);
      }
    } finally {
      db.close();
    }
  });

  it('accepts NULL and nonnegative pin timestamps but rejects negative values', () => {
    const db = makeDbThrough(39);
    try {
      insertSession(db, 'constraints');
      db.prepare(`UPDATE sessions SET pinned_at = 0 WHERE id = 'constraints'`).run();
      expect(db.prepare(`SELECT pinned_at FROM sessions WHERE id = 'constraints'`).get()).toEqual({
        pinned_at: 0,
      });
      db.prepare(`UPDATE sessions SET pinned_at = 123456789 WHERE id = 'constraints'`).run();
      expect(db.prepare(`SELECT pinned_at FROM sessions WHERE id = 'constraints'`).get()).toEqual({
        pinned_at: 123456789,
      });
      expect(() =>
        db.prepare(`UPDATE sessions SET pinned_at = -1 WHERE id = 'constraints'`).run(),
      ).toThrow();
      db.prepare(`UPDATE sessions SET pinned_at = NULL WHERE id = 'constraints'`).run();
      expect(db.prepare(`SELECT pinned_at FROM sessions WHERE id = 'constraints'`).get()).toEqual({
        pinned_at: null,
      });
    } finally {
      db.close();
    }
  });

  it('defines partial predicates and directions for lifecycle, live ordering, and retention', () => {
    const db = makeDbThrough(39);
    try {
      expect(indexSql(db, 'idx_sessions_unpinned_live_lifecycle_last_event')).toContain(
        'WHERE archived_at IS NULL AND pinned_at IS NULL',
      );
      expect(indexSql(db, 'idx_sessions_live_pinned_last_event')).toContain(
        "ON sessions(pinned_at DESC, last_event_at DESC, id ASC)",
      );
      expect(indexSql(db, 'idx_sessions_live_pinned_last_event')).toContain(
        "WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant')",
      );
      expect(indexSql(db, 'idx_sessions_unpinned_history_last_event')).toContain(
        'ON sessions(last_event_at ASC, id ASC)',
      );
      expect(indexSql(db, 'idx_sessions_unpinned_history_last_event')).toContain(
        "WHERE pinned_at IS NULL AND (lifecycle = 'closed' OR archived_at IS NOT NULL)",
      );
    } finally {
      db.close();
    }
  });

  it('uses the focused indexes for the exact scheduler, live UI, and retention query shapes', () => {
    const db = makeDbThrough(39);
    try {
      for (let index = 0; index < 300; index += 1) {
        const lifecycle = index % 3 === 0 ? 'active' : index % 3 === 1 ? 'dormant' : 'closed';
        insertSession(db, `session-${index.toString().padStart(3, '0')}`, lifecycle, index);
      }
      db.prepare(`UPDATE sessions SET pinned_at = last_event_at WHERE last_event_at % 10 = 0`).run();
      db.prepare(
        `UPDATE sessions SET archived_at = last_event_at
         WHERE lifecycle != 'active' AND last_event_at % 7 = 0`,
      ).run();
      db.exec('ANALYZE');

      const lifecyclePlan = explain(
        db,
        `SELECT * FROM sessions
         WHERE lifecycle = 'active' AND archived_at IS NULL
           AND pinned_at IS NULL AND last_event_at < ?`,
        250,
      );
      expect(lifecyclePlan.join('\n')).toContain(
        'idx_sessions_unpinned_live_lifecycle_last_event',
      );

      const livePlan = explain(
        db,
        `SELECT * FROM sessions
         WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant')
         ORDER BY pinned_at DESC, last_event_at DESC, id ASC
         LIMIT ?`,
        100,
      );
      expect(livePlan.join('\n')).toContain('idx_sessions_live_pinned_last_event');
      expect(livePlan.join('\n')).not.toContain('USE TEMP B-TREE FOR ORDER BY');

      const retentionPlan = explain(
        db,
        `SELECT id FROM sessions
         WHERE pinned_at IS NULL AND last_event_at < ?
           AND (lifecycle = 'closed' OR archived_at IS NOT NULL)
         ORDER BY last_event_at ASC, id ASC
         LIMIT ?`,
        250,
        500,
      );
      expect(retentionPlan.join('\n')).toContain('idx_sessions_unpinned_history_last_event');
      expect(retentionPlan.join('\n')).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    } finally {
      db.close();
    }
  });
});
