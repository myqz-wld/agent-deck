import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import {
  compressSessionHandOffAliasesWithDb,
  deleteSessionHandOffAliasWithDb,
  findSessionHandOffSuccessorWithDb,
  recordSessionHandOffAliasWithDb,
} from '../session-handoff-alias-repo';
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

describe.skipIf(!bindingAvailable)('v042 durable session handoff aliases', () => {
  it('registers after v041 and keeps aliases independent from source session retention', () => {
    const v041Index = MIGRATIONS.findIndex((migration) => migration.version === 41);
    const v042Index = MIGRATIONS.findIndex((migration) => migration.version === 42);
    expect(v042Index).toBe(v041Index + 1);
    expect(MIGRATIONS[v042Index]).toMatchObject({
      version: 42,
      name: 'session_handoff_aliases',
    });

    const db = makeDbThrough(41);
    try {
      db.exec(MIGRATIONS[v042Index]!.sql);
      recordSessionHandOffAliasWithDb(db, 'source-a', 'successor-b', 100);
      compressSessionHandOffAliasesWithDb(db, 'successor-b', 'successor-c');
      recordSessionHandOffAliasWithDb(db, 'successor-b', 'successor-c', 200);

      expect(findSessionHandOffSuccessorWithDb(db, 'source-a')).toBe('successor-c');
      expect(findSessionHandOffSuccessorWithDb(db, 'successor-b')).toBe('successor-c');
      expect(deleteSessionHandOffAliasWithDb(db, 'source-a')).toBe(true);
      expect(findSessionHandOffSuccessorWithDb(db, 'source-a')).toBeNull();
      expect(db.prepare(
        `PRAGMA foreign_key_list('session_handoff_aliases')`,
      ).all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
