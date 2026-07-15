import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import {
  buildKeywordPredicate,
  shouldIncludeLegacyEventIndex,
} from '../search-predicate';
import { retireLegacyEventSearchIndexOnShutdown } from '../storage-maintenance/event-search';
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

function insertSession(
  db: Database.Database,
  id: string,
  title = 'generic title',
  cwd = '/repo',
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', ?, ?, 'sdk', 'closed', 'idle', 1, 1)`,
  ).run(id, cwd, title);
}

function matchRowids(db: Database.Database, table: string, keyword: string): number[] {
  return db.prepare(
    `SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`,
  ).pluck().all(`"${keyword}"`) as number[];
}

describe.skipIf(!bindingAvailable)('v043 case-insensitive history search', () => {
  it('registers next, rebuilds both FTS indexes, and preserves bounded search semantics', () => {
    const v042Index = MIGRATIONS.findIndex((migration) => migration.version === 42);
    const v043Index = MIGRATIONS.findIndex((migration) => migration.version === 43);
    expect(v043Index).toBe(v042Index + 1);
    expect(MIGRATIONS[v043Index]).toMatchObject({
      version: 43,
      name: 'history_search_case_insensitive',
    });

    const db = makeDbThrough(40);
    try {
      insertSession(db, 'event-session');
      insertSession(db, 'summary-session');
      const longMiddle = `${'x'.repeat(3_000)} MiddleOnlyMarker ${'y'.repeat(3_000)}`;
      const eventId = Number(db.prepare(
        `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
         VALUES ('event-session', 'tool-use-end', ?, 10, 'tool-1')`,
      ).run(JSON.stringify({
        toolName: 'Bash',
        toolResult: `HeadFooBar ${longMiddle} TailFooBar`,
      })).lastInsertRowid);
      const summaryId = Number(db.prepare(
        `INSERT INTO summaries(session_id, content, trigger, ts)
         VALUES ('summary-session', 'SummaryFooBar evidence', 'manual', 11)`,
      ).run().lastInsertRowid);
      db.exec(MIGRATIONS.find((migration) => migration.version === 41)!.sql);
      db.exec(MIGRATIONS.find((migration) => migration.version === 42)!.sql);
      expect(db.prepare('SELECT count(*) FROM event_search_fts_v1').pluck().get()).toBe(0);

      db.exec(MIGRATIONS[v043Index]!.sql);

      const eventSql = String(db.prepare(
        `SELECT sql FROM sqlite_master WHERE name = 'event_search_fts_v1'`,
      ).pluck().get());
      const summarySql = String(db.prepare(
        `SELECT sql FROM sqlite_master WHERE name = 'summaries_fts'`,
      ).pluck().get());
      expect(eventSql).toContain('trigram case_sensitive 0');
      expect(summarySql).toContain('trigram case_sensitive 0');
      expect(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events_fts'`,
      ).get()).toBeUndefined();

      for (const keyword of ['headfoobar', 'HEADFOOBAR', 'HeadFooBar']) {
        expect(matchRowids(db, 'event_search_fts_v1', keyword)).toEqual([eventId]);
      }
      for (const keyword of ['summaryfoobar', 'SUMMARYFOOBAR', 'SummaryFooBar']) {
        expect(matchRowids(db, 'summaries_fts', keyword)).toEqual([summaryId]);
      }
      expect(matchRowids(db, 'event_search_fts_v1', 'MiddleOnlyMarker')).toEqual([]);
      expect(matchRowids(db, 'event_search_fts_v1', 'tailfoobar')).toEqual([eventId]);

      expect(db.prepare(
        `SELECT event_id FROM event_search_source_v1
         EXCEPT SELECT rowid FROM event_search_fts_v1`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
         EXCEPT SELECT event_id FROM event_search_source_v1`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT id FROM summaries EXCEPT SELECT rowid FROM summaries_fts`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT rowid FROM summaries_fts EXCEPT SELECT id FROM summaries`,
      ).all()).toEqual([]);
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.prepare(
        `INSERT INTO event_search_fts_v1(event_search_fts_v1) VALUES('integrity-check')`,
      ).run();
      db.prepare(
        `INSERT INTO summaries_fts(summaries_fts, rank) VALUES('integrity-check', 1)`,
      ).run();
    } finally {
      db.close();
    }
  });

  it('keeps event and summary triggers synchronized for insert, update, and delete', () => {
    const db = makeDbThrough(43);
    try {
      insertSession(db, 'trigger-session');
      const eventId = Number(db.prepare(
        `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
         VALUES ('trigger-session', 'message', ?, 10, NULL)`,
      ).run(JSON.stringify({ text: 'InsertFooBar' })).lastInsertRowid);
      const summaryId = Number(db.prepare(
        `INSERT INTO summaries(session_id, content, trigger, ts)
         VALUES ('trigger-session', 'InsertSummaryBar', 'manual', 11)`,
      ).run().lastInsertRowid);
      expect(matchRowids(db, 'event_search_fts_v1', 'insertfoobar')).toEqual([eventId]);
      expect(matchRowids(db, 'summaries_fts', 'INSERTSUMMARYBAR')).toEqual([summaryId]);

      db.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run(
        JSON.stringify({ text: 'UpdateFooBar' }),
        eventId,
      );
      db.prepare('UPDATE summaries SET content = ? WHERE id = ?').run(
        'UpdateSummaryBar',
        summaryId,
      );
      expect(matchRowids(db, 'event_search_fts_v1', 'insertfoobar')).toEqual([]);
      expect(matchRowids(db, 'event_search_fts_v1', 'UPDATEFOOBAR')).toEqual([eventId]);
      expect(matchRowids(db, 'summaries_fts', 'insertsummarybar')).toEqual([]);
      expect(matchRowids(db, 'summaries_fts', 'updatesummarybar')).toEqual([summaryId]);

      db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
      db.prepare('DELETE FROM summaries WHERE id = ?').run(summaryId);
      expect(matchRowids(db, 'event_search_fts_v1', 'updatefoobar')).toEqual([]);
      expect(matchRowids(db, 'summaries_fts', 'updatesummarybar')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('retires every older maintenance phase and keeps two-character search title/cwd-only', () => {
    const db = makeDbThrough(42);
    try {
      insertSession(db, 'title-hit', 'contains Ab marker');
      insertSession(db, 'cwd-hit', 'generic', '/Repo/AB-path');
      insertSession(db, 'event-only');
      insertSession(db, 'summary-only');
      db.prepare(
        `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
         VALUES ('event-only', 'message', ?, 10, NULL)`,
      ).run(JSON.stringify({ text: 'Ab' }));
      db.prepare(
        `INSERT INTO summaries(session_id, content, trigger, ts)
         VALUES ('summary-only', 'Ab', 'manual', 11)`,
      ).run();
      db.prepare(
        `UPDATE storage_maintenance_state
            SET phase = 'retire-on-shutdown'
          WHERE task = 'event-search-v1'`,
      ).run();

      db.exec(MIGRATIONS.find((migration) => migration.version === 43)!.sql);
      expect(db.prepare(
        `SELECT phase FROM storage_maintenance_state WHERE task = 'event-search-v1'`,
      ).pluck().get()).toBe('complete');
      expect(shouldIncludeLegacyEventIndex(db)).toBe(false);
      expect(retireLegacyEventSearchIndexOnShutdown(db).retired).toBe(false);

      const predicate = buildKeywordPredicate('aB');
      expect(db.prepare(
        `SELECT id FROM sessions WHERE ${predicate.sql} ORDER BY id`,
      ).pluck().all(predicate.params)).toEqual(['cwd-hit', 'title-hit']);
      expect(predicate.sql).not.toContain('_fts');
    } finally {
      db.close();
    }
  });
});
