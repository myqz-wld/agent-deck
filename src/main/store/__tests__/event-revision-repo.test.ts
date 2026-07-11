/** v037 revision read-model tests backed by the registered production migration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { eventRepo } from '../event-repo';
import {
  createEventRevisionRepo,
  eventRevisionRepo,
  MAX_EVENT_REVISION_PAGE_SIZE,
  type EventRevisionRepo,
} from '../event-revision-repo';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

const dbHolder: { current: Database.Database | null } = { current: null };

vi.mock('@main/store/db', () => ({
  getDb: () => {
    if (!dbHolder.current) throw new Error('[event-revision-repo.test] test DB not installed');
    return dbHolder.current;
  },
}));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version >= 37) break;
    db.exec(migration.sql);
  }
  const v037 = MIGRATIONS.find((migration) => migration.version === 37);
  if (!v037) throw new Error('v037 event_revisions migration must be registered for this suite');
  db.exec(v037.sql);
  return db;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', '/tmp', ?, 'sdk', 'active', 'idle', 1000, 1000)`,
  ).run(id, `title-${id}`);
}

function insertEvent(
  db: Database.Database,
  sessionId: string,
  payloadJson: string,
  ts: number,
): number {
  const info = db
    .prepare(`INSERT INTO events (session_id, kind, payload_json, ts) VALUES (?, 'message', ?, ?)`)
    .run(sessionId, payloadJson, ts);
  return Number(info.lastInsertRowid);
}

function expressionIndexName(db: Database.Database): string {
  const indexes = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL`,
    )
    .all() as { name: string; sql: string }[];
  const index = indexes.find(({ sql }) => /COALESCE\s*\(\s*change_revision\s*,\s*id\s*\)/i.test(sql));
  expect(index, 'v037 expression index exists').toBeDefined();
  return index!.name;
}

describe.skipIf(!bindingAvailable)('event revision repository / v037 effective-revision keyset', () => {
  let db: Database.Database;
  let repo: EventRevisionRepo;

  beforeEach(() => {
    db = makeDb();
    dbHolder.current = db;
    repo = createEventRevisionRepo(db);
    insertSession(db, 'session-a');
  });

  afterEach(() => {
    dbHolder.current = null;
    db.close();
  });

  it('reads the trigger-owned revision/rebuild state through injected and production seams', () => {
    expect(repo.state('session-a')).toEqual({
      sessionId: 'session-a', revision: 0, rebuildAfterRevision: 0,
    });
    expect(eventRevisionRepo.state('session-a')).toEqual(repo.state('session-a'));
    expect(repo.state('missing')).toBeNull();

    insertEvent(db, 'session-a', '{"text":"first"}', 1);
    expect(repo.state('session-a')).toEqual({
      sessionId: 'session-a', revision: 1, rebuildAfterRevision: 0,
    });
  });

  it('returns raw malformed payloads, legacy NULL revisions, inclusive coverage, and id tie-breaks', () => {
    const id1 = insertEvent(db, 'session-a', '{malformed JSON', 1);
    const id2 = insertEvent(db, 'session-a', '{"text":"legacy"}', 2);
    const id3 = insertEvent(db, 'session-a', '{"text":"same revision"}', 3);
    db.prepare(`UPDATE events SET change_revision = NULL WHERE id = ?`).run(id1);
    db.prepare(`UPDATE events SET change_revision = 50 WHERE id IN (?, ?)`)
      .run(id2, id3);

    const throughOne = repo.listRawEvents({ sessionId: 'session-a', throughRevision: id1, limit: 10 });
    expect(throughOne).toEqual([expect.objectContaining({
      id: id1, effectiveRevision: id1, payloadJson: '{malformed JSON',
    })]);

    const throughFifty = repo.listRawEvents({ sessionId: 'session-a', throughRevision: 50, limit: 10 });
    expect(throughFifty.map((row) => [row.effectiveRevision, row.id])).toEqual([
      [id1, id1], [50, id2], [50, id3],
    ]);
    const afterFirstTie = repo.listRawEvents({
      sessionId: 'session-a', throughRevision: 50, after: { revision: 50, id: id2 }, limit: 10,
    });
    expect(afterFirstTie.map((row) => row.id)).toEqual([id3]);
  });

  it('pages 100,000 rows without gaps or duplicates and uses the expression index without a scan/sort', () => {
    const total = 100_000;
    const insert = db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts) VALUES ('session-a', 'message', ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < total; i++) insert.run(`{"sequence":${i}}`, i);
    })();

    const throughRevision = repo.state('session-a')!.revision;
    let after: { revision: number; id: number } | undefined;
    const ids: number[] = [];
    for (;;) {
      const page = repo.listRawEvents({ sessionId: 'session-a', throughRevision, after, limit: 257 });
      if (page.length === 0) break;
      ids.push(...page.map((row) => row.id));
      const last = page.at(-1)!;
      after = { revision: last.effectiveRevision, id: last.id };
    }
    expect(ids).toHaveLength(total);
    for (let index = 0; index < total; index++) {
      if (ids[index] !== index + 1) throw new Error(`keyset gap/duplicate at ${index}: ${ids[index]}`);
    }

    const expressionIndex = expressionIndexName(db);
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, session_id, COALESCE(change_revision, id) AS effective_revision,
              kind, payload_json, ts, tool_use_id
       FROM events
       WHERE session_id = ?
         AND COALESCE(change_revision, id) <= ?
         AND (COALESCE(change_revision, id), id) > (?, ?)
       ORDER BY COALESCE(change_revision, id) ASC, id ASC
       LIMIT ?`,
    ).all('session-a', throughRevision, 0, 0, 257) as { detail: string }[];
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toContain(expressionIndex);
    expect(details).not.toMatch(/\bSCAN\s+events\b/i);
    expect(details).not.toMatch(/USE TEMP B-TREE/i);
  }, 30_000);

  it('clamps keyset limits to a finite, nonzero page', () => {
    for (let i = 0; i < MAX_EVENT_REVISION_PAGE_SIZE + 2; i++) {
      insertEvent(db, 'session-a', `{"sequence":${i}}`, i);
    }
    const throughRevision = repo.state('session-a')!.revision;
    expect(repo.listRawEvents({ sessionId: 'session-a', throughRevision, limit: -1 })).toHaveLength(1);
    expect(repo.listRawEvents({ sessionId: 'session-a', throughRevision, limit: 99_999 }))
      .toHaveLength(MAX_EVENT_REVISION_PAGE_SIZE);
  });

  it('eventRepo tool-use merge keeps one id and advances the revision once per business mutation', () => {
    const start = repo.state('session-a')!;
    const id = eventRepo.insert({
      sessionId: 'session-a', agentId: '', kind: 'tool-use-start', ts: 1,
      payload: { toolUseId: 'tool-1', toolInput: { command: 'first' } },
    });
    const afterInsert = repo.state('session-a')!;
    const mergedId = eventRepo.insert({
      sessionId: 'session-a', agentId: '', kind: 'tool-use-start', ts: 2,
      payload: { toolUseId: 'tool-1', outputDelta: 'merged' },
    });
    const afterMerge = repo.state('session-a')!;

    expect(mergedId).toBe(id);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id = ?`).get(id))
      .toEqual({ count: 1 });
    expect(afterInsert.revision).toBe(start.revision + 1);
    expect(afterMerge.revision).toBe(afterInsert.revision + 1);
    expect(repo.listRawEvents({ sessionId: 'session-a', throughRevision: afterMerge.revision, limit: 10 }))
      .toEqual([expect.objectContaining({ id, effectiveRevision: afterMerge.revision })]);
  });
});
