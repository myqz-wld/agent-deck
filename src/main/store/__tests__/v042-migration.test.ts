import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import {
  compressSessionHandOffAliasesWithDb,
  deleteSessionHandOffAliasWithDb,
  findSessionHandOffSuccessorWithDb,
  listSessionHandOffAliasPagesWithDb,
  listSessionHandOffPredecessorsWithDb,
  listSessionHandOffAliasesForSuccessorsWithDb,
  probeSessionHandOffAliasesWithDb,
  recordSessionHandOffAliasWithDb,
} from '../session-handoff-alias-repo';
import { sessionOwnershipLineagesWithAliasReader } from '@main/session/hand-off/ownership';
import { bindingAvailable } from './_binding-probe';

function makeDbThrough(
  version: number,
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void,
): Database.Database {
  const db = new Database(':memory:', verbose ? { verbose } : undefined);
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
      expect(listSessionHandOffPredecessorsWithDb(db, 'successor-c')).toEqual([
        'source-a',
        'successor-b',
      ]);
      expect(listSessionHandOffAliasesForSuccessorsWithDb(db, ['successor-c'])).toEqual([
        { sourceSessionId: 'source-a', successorSessionId: 'successor-c' },
        { sourceSessionId: 'successor-b', successorSessionId: 'successor-c' },
      ]);
      expect(deleteSessionHandOffAliasWithDb(db, 'source-a')).toBe(true);
      expect(findSessionHandOffSuccessorWithDb(db, 'source-a')).toBeNull();
      expect(db.prepare(
        `PRAGMA foreign_key_list('session_handoff_aliases')`,
      ).all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('applies the requested SQL-side row bound before returning a large fan-in', () => {
    const db = makeDbThrough(42);
    try {
      const insert = db.transaction(() => {
        for (let index = 0; index < 1_100; index += 1) {
          recordSessionHandOffAliasWithDb(db, `source-${index}`, 'successor', index);
        }
      });
      insert();

      const rows = listSessionHandOffAliasesForSuccessorsWithDb(db, ['successor'], 128);
      expect(rows).toHaveLength(128);
      expect(new Set(rows.map((row) => row.successorSessionId))).toEqual(new Set(['successor']));
    } finally {
      db.close();
    }
  });

  it('applies the row bound per successor across SQL chunks', () => {
    const db = makeDbThrough(42);
    try {
      for (let index = 0; index < 10; index += 1) {
        recordSessionHandOffAliasWithDb(db, `a-source-${index}`, 'successor-a', index);
      }
      recordSessionHandOffAliasWithDb(db, 'b-source', 'successor-b', 20);
      const roots = [
        'successor-a',
        ...Array.from({ length: 399 }, (_, index) => `empty-${index}`),
        'successor-b',
      ];

      const rows = listSessionHandOffAliasesForSuccessorsWithDb(db, roots, 2);
      expect(rows.filter((row) => row.successorSessionId === 'successor-a')).toHaveLength(2);
      expect(rows).toContainEqual({
        sourceSessionId: 'b-source',
        successorSessionId: 'successor-b',
      });
    } finally {
      db.close();
    }
  });

  it('preserves another root deep chain after a wide root reaches its lineage cap', () => {
    const db = makeDbThrough(42);
    try {
      let createdAt = 0;
      const insert = db.transaction(() => {
        for (let index = 1; index <= 1_023; index += 1) {
          const source = `a-${index}`;
          recordSessionHandOffAliasWithDb(db, source, 'root-a', createdAt++);
          for (let predecessor = 1; predecessor <= 8; predecessor += 1) {
            recordSessionHandOffAliasWithDb(
              db,
              `${source}-predecessor-${predecessor}`,
              source,
              createdAt++,
            );
          }
        }
        recordSessionHandOffAliasWithDb(db, 'b1', 'root-b', createdAt++);
        recordSessionHandOffAliasWithDb(db, 'b2', 'b1', createdAt++);
        recordSessionHandOffAliasWithDb(db, 'b3', 'b2', createdAt++);
      });
      insert();

      const lineages = sessionOwnershipLineagesWithAliasReader(
        ['root-a', 'root-b'],
        (requests) => listSessionHandOffAliasPagesWithDb(db, requests),
        (requests) => probeSessionHandOffAliasesWithDb(db, requests),
      );
      expect(lineages.get('root-a')).toHaveLength(1_024);
      expect(lineages.get('root-b')).toEqual(['root-b', 'b1', 'b2', 'b3']);
    } finally {
      db.close();
    }
  });

  it('batches a wide empty frontier instead of issuing one synchronous query per leaf', () => {
    const statements: string[] = [];
    const db = makeDbThrough(42, (message) => statements.push(String(message)));
    try {
      const insert = db.transaction(() => {
        for (let index = 1; index <= 1_022; index += 1) {
          recordSessionHandOffAliasWithDb(db, `leaf-${index}`, 'current', index);
        }
      });
      insert();
      statements.length = 0;

      const lineages = sessionOwnershipLineagesWithAliasReader(
        ['current'],
        (requests) => listSessionHandOffAliasPagesWithDb(db, requests),
        (requests) => probeSessionHandOffAliasesWithDb(db, requests),
      );
      const aliasSelects = statements.filter((statement) =>
        statement.includes('FROM session_handoff_aliases'));
      expect(lineages.get('current')).toHaveLength(1_023);
      expect(aliasSelects).toHaveLength(22);
    } finally {
      db.close();
    }
  });
});
