/**
 * v037 migration tests — trigger-owned per-session event revisions.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

interface RevisionRow {
  sessionId: string;
  revision: number;
  rebuildAfterRevision: number;
}

interface EventRevisionRow {
  id: number;
  changeRevision: number | null;
}

function makeV036Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > 36) break;
    db.exec(migration.sql);
  }
  return db;
}

function migrationV037(): string {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 37);
  expect(migration).toEqual(
    expect.objectContaining({ version: 37, name: 'event_revisions' }),
  );
  return migration!.sql;
}

function applyV037(db: Database.Database): void {
  db.exec(migrationV037());
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', 'active', 'idle', 1000, 1000)`,
  ).run(id, `title-${id}`);
}

function revision(db: Database.Database, sessionId: string): RevisionRow | undefined {
  return db
    .prepare(
      `SELECT session_id AS sessionId, revision,
              rebuild_after_revision AS rebuildAfterRevision
       FROM session_event_revisions WHERE session_id = ?`,
    )
    .get(sessionId) as RevisionRow | undefined;
}

function eventRevision(db: Database.Database, id: number): EventRevisionRow | undefined {
  return db
    .prepare('SELECT id, change_revision AS changeRevision FROM events WHERE id = ?')
    .get(id) as EventRevisionRow | undefined;
}

function insertOldStyleEvent(
  db: Database.Database,
  sessionId: string,
  payload = '{"text":"one"}',
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES (?, 'message', ?, 1000)`,
      )
      .run(sessionId, payload).lastInsertRowid,
  );
}

describe.skipIf(!bindingAvailable)('v037 migration / event revisions', () => {
  it('is registered after v036 and backfills legacy and zero-event sessions without stamping rows', () => {
    const v036Index = MIGRATIONS.findIndex((migration) => migration.version === 36);
    const v037Index = MIGRATIONS.findIndex((migration) => migration.version === 37);
    expect(v037Index).toBe(v036Index + 1);
    expect(MIGRATIONS[v037Index]).toEqual(
      expect.objectContaining({ version: 37, name: 'event_revisions' }),
    );

    const db = makeV036Db();
    try {
      insertSession(db, 'with-events');
      insertSession(db, 'empty');
      db.exec(`
        INSERT INTO events (id, session_id, kind, payload_json, ts)
        VALUES (7, 'with-events', 'message', '{"text":"first"}', 700);
        INSERT INTO events (id, session_id, kind, payload_json, ts)
        VALUES (19, 'with-events', 'message', '{"text":"second"}', 1900);
      `);

      applyV037(db);

      const changeRevisionColumn = (
        db.prepare(`PRAGMA table_info('events')`).all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((column) => column.name === 'change_revision');
      expect(changeRevisionColumn).toMatchObject({
        name: 'change_revision',
        notnull: 0,
        dflt_value: null,
      });
      expect(
        db.prepare('SELECT id, change_revision FROM events ORDER BY id').all(),
      ).toEqual([
        { id: 7, change_revision: null },
        { id: 19, change_revision: null },
      ]);
      expect(revision(db, 'with-events')).toEqual({
        sessionId: 'with-events',
        revision: 19,
        rebuildAfterRevision: 0,
      });
      expect(revision(db, 'empty')).toEqual({
        sessionId: 'empty',
        revision: 0,
        rebuildAfterRevision: 0,
      });
      expect(
        db.prepare(`PRAGMA table_info('session_event_revisions')`).all(),
      ).toEqual([
        expect.objectContaining({ name: 'session_id', notnull: 0, pk: 1 }),
        expect.objectContaining({ name: 'revision', notnull: 1, dflt_value: null }),
        expect.objectContaining({
          name: 'rebuild_after_revision',
          notnull: 1,
          dflt_value: '0',
        }),
      ]);

      insertSession(db, 'created-after-v037');
      expect(revision(db, 'created-after-v037')).toEqual({
        sessionId: 'created-after-v037',
        revision: 0,
        rebuildAfterRevision: 0,
      });

      expect(
        db.prepare(`PRAGMA foreign_key_list('session_event_revisions')`).all(),
      ).toEqual([
        expect.objectContaining({
          table: 'sessions',
          from: 'session_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it.each([0, 1])(
    'allocates exactly once for direct INSERT/business UPDATE/DELETE with recursive_triggers=%i',
    (recursiveTriggers) => {
      const db = makeV036Db();
      try {
        applyV037(db);
        if (recursiveTriggers === 0) {
          expect(db.pragma('recursive_triggers', { simple: true })).toBe(0);
        } else {
          db.pragma('recursive_triggers = ON');
        }
        expect(db.pragma('recursive_triggers', { simple: true })).toBe(recursiveTriggers);
        insertSession(db, 'mutation');

        const eventId = insertOldStyleEvent(db, 'mutation');
        expect(eventRevision(db, eventId)).toEqual({ id: eventId, changeRevision: 1 });
        expect(revision(db, 'mutation')).toMatchObject({
          revision: 1,
          rebuildAfterRevision: 0,
        });

        db.prepare(
          `UPDATE events SET payload_json = '{"text":"two"}', ts = 2000 WHERE id = ?`,
        ).run(eventId);
        expect(eventRevision(db, eventId)).toEqual({ id: eventId, changeRevision: 2 });
        expect(revision(db, 'mutation')).toMatchObject({ revision: 2 });

        // Naming business columns with unchanged values must not allocate a revision.
        db.prepare('UPDATE events SET kind = kind, payload_json = payload_json WHERE id = ?').run(
          eventId,
        );
        expect(revision(db, 'mutation')).toMatchObject({ revision: 2 });

        // This is the internal self-stamp shape and must not re-enter the business trigger.
        db.prepare('UPDATE events SET change_revision = change_revision WHERE id = ?').run(eventId);
        expect(revision(db, 'mutation')).toMatchObject({ revision: 2 });

        db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
        expect(eventRevision(db, eventId)).toBeUndefined();
        expect(revision(db, 'mutation')).toEqual({
          sessionId: 'mutation',
          revision: 3,
          rebuildAfterRevision: 3,
        });
      } finally {
        db.close();
      }
    },
  );

  it.each([0, 1])(
    'handles tool merge updates and ignores change_revision-only and session_id-only updates with recursive_triggers=%i',
    (recursiveTriggers) => {
      const db = makeV036Db();
      try {
        applyV037(db);
        if (recursiveTriggers === 0) {
          expect(db.pragma('recursive_triggers', { simple: true })).toBe(0);
        } else {
          db.pragma('recursive_triggers = ON');
        }
        insertSession(db, 'source');
        insertSession(db, 'target');

        const insert = db.prepare(
          `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
           VALUES ('source', 'tool-use-start', ?, ?, 'tool-1')
           ON CONFLICT (session_id, kind, tool_use_id)
             WHERE kind = 'tool-use-start' AND tool_use_id IS NOT NULL
           DO UPDATE SET payload_json = excluded.payload_json, ts = excluded.ts`,
        );
        const eventId = Number(insert.run('{"output":"partial"}', 1000).lastInsertRowid);
        expect(revision(db, 'source')).toMatchObject({ revision: 1 });
        expect(eventRevision(db, eventId)).toEqual({ id: eventId, changeRevision: 1 });

        insert.run('{"output":"complete"}', 2000);
        expect(revision(db, 'source')).toMatchObject({ revision: 2 });
        expect(eventRevision(db, eventId)).toEqual({ id: eventId, changeRevision: 2 });

        db.prepare('UPDATE events SET change_revision = 500 WHERE id = ?').run(eventId);
        expect(revision(db, 'source')).toMatchObject({ revision: 2 });
        expect(eventRevision(db, eventId)).toEqual({ id: eventId, changeRevision: 500 });

        db.prepare(`UPDATE events SET session_id = 'target' WHERE id = ?`).run(eventId);
        expect(revision(db, 'source')).toMatchObject({ revision: 2 });
        expect(revision(db, 'target')).toMatchObject({ revision: 0 });
        expect(eventRevision(db, eventId)).toEqual({ id: eventId, changeRevision: 500 });
      } finally {
        db.close();
      }
    },
  );

  it.each([0, 1])(
    'does not preserve or recreate cursor state during a parent cascade with recursive_triggers=%i',
    (recursiveTriggers) => {
      const db = makeV036Db();
      try {
        applyV037(db);
        if (recursiveTriggers === 0) {
          expect(db.pragma('recursive_triggers', { simple: true })).toBe(0);
        } else {
          db.pragma('recursive_triggers = ON');
        }
        insertSession(db, 'cascade');
        insertOldStyleEvent(db, 'cascade');
        expect(revision(db, 'cascade')).toMatchObject({ revision: 1 });

        db.prepare(`DELETE FROM sessions WHERE id = 'cascade'`).run();

        expect(revision(db, 'cascade')).toBeUndefined();
        expect(
          db.prepare(`SELECT COUNT(*) AS count FROM events WHERE session_id = 'cascade'`).get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it('defines the effective-revision expression index and uses it for bounded keyset scans', () => {
    const db = makeV036Db();
    try {
      applyV037(db);
      insertSession(db, 'scan');
      for (let index = 0; index < 200; index += 1) {
        insertOldStyleEvent(db, 'scan', `{"index":${index}}`);
      }

      const indexSql = db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_events_session_effective_revision'`,
        )
        .pluck()
        .get() as string;
      expect(indexSql.replace(/\s+/g, ' ')).toContain(
        'ON events (session_id, COALESCE(change_revision, id), id)',
      );

      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT id, kind, payload_json, ts, tool_use_id,
                  COALESCE(change_revision, id) AS effective_revision
           FROM events
           WHERE session_id = ?
             AND (COALESCE(change_revision, id), id) > (?, ?)
             AND COALESCE(change_revision, id) <= ?
           ORDER BY COALESCE(change_revision, id), id
           LIMIT ?`,
        )
        .all('scan', 50, 50, 150, 25) as Array<{ detail: string }>;
      const details = plan.map((row) => row.detail).join('\n');
      expect(details).toContain('idx_events_session_effective_revision');
      expect(details).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    } finally {
      db.close();
    }
  });
});
