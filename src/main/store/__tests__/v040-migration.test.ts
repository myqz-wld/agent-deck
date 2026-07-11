import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

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

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', '/repo', ?, 'sdk', 'active', 'idle', 1, 1)`,
  ).run(id, id);
}

describe.skipIf(!bindingAvailable)('v040 summary revision metadata', () => {
  it('registers immediately after v039 and preserves legacy summaries', () => {
    const v039Index = MIGRATIONS.findIndex((migration) => migration.version === 39);
    const v040Index = MIGRATIONS.findIndex((migration) => migration.version === 40);
    expect(v040Index).toBe(v039Index + 1);
    expect(MIGRATIONS[v040Index]).toMatchObject({
      version: 40,
      name: 'summary_revision_metadata',
    });

    const db = makeDbThrough(39);
    try {
      insertSession(db, 'legacy');
      db.prepare(
        `INSERT INTO summaries (session_id, content, trigger, ts)
         VALUES ('legacy', 'old summary', 'time', 10)`,
      ).run();
      db.exec(MIGRATIONS[v040Index].sql);

      expect(
        db.prepare(
          `SELECT content, source_event_revision, source_rebuild_after_revision,
                  generation_source FROM summaries`,
        ).get(),
      ).toEqual({
        content: 'old summary',
        source_event_revision: null,
        source_rebuild_after_revision: null,
        generation_source: 'legacy',
      });
    } finally {
      db.close();
    }
  });

  it('accepts bounded provenance and rejects invalid revisions or sources', () => {
    const db = makeDbThrough(40);
    try {
      insertSession(db, 'new');
      const insert = db.prepare(
        `INSERT INTO summaries (
           session_id, content, trigger, ts, source_event_revision,
           source_rebuild_after_revision, generation_source
         ) VALUES ('new', ?, 'event-count', 20, ?, ?, ?)`,
      );
      insert.run('rich', 7, 3, 'llm');
      expect(
        db.prepare(
          `SELECT source_event_revision, source_rebuild_after_revision, generation_source
             FROM summaries WHERE content = 'rich'`,
        ).get(),
      ).toEqual({
        source_event_revision: 7,
        source_rebuild_after_revision: 3,
        generation_source: 'llm',
      });
      expect(() => insert.run('negative', -1, 0, 'llm')).toThrow();
      expect(() => insert.run('negative epoch', 8, -1, 'llm')).toThrow();
      expect(() => insert.run('epoch ahead', 8, 9, 'llm')).toThrow();
      expect(() => insert.run('unknown', 8, 0, 'unknown')).toThrow();
    } finally {
      db.close();
    }
  });

  it('adds the partial session/revision index without changing FTS summary content', () => {
    const db = makeDbThrough(40);
    try {
      insertSession(db, 'fts');
      db.prepare(
        `INSERT INTO summaries (
           session_id, content, trigger, ts, source_event_revision,
           source_rebuild_after_revision, generation_source
         ) VALUES ('fts', 'revision evidence summary', 'manual', 30, 9, 0, 'stats-fallback')`,
      ).run();
      expect(
        db.prepare(
          `SELECT content FROM summaries_fts WHERE summaries_fts MATCH 'revision'`,
        ).get(),
      ).toEqual({ content: 'revision evidence summary' });
      const index = db
        .prepare(
          `SELECT sql FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_summaries_session_source_revision'`,
        )
        .pluck()
        .get() as string;
      expect(index).toContain('source_event_revision DESC');
      expect(index).toContain('WHERE source_event_revision IS NOT NULL');
    } finally {
      db.close();
    }
  });
});
