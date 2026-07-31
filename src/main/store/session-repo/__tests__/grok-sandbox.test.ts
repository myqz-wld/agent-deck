import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { bindingAvailable, makeMemoryDb } from './_setup';
import { renameWithDb } from '../rename';

let currentDb: Database.Database | null = null;
vi.mock('../../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('Grok sandbox test DB is not initialized');
    return currentDb;
  },
}));

import { sessionRepo } from '../index';

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'grok-build', '/repo', ?, 'sdk', 'active', 'idle', 1, 1)`,
  ).run(id, id);
}

describe.skipIf(!bindingAvailable)('session Grok sandbox persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    currentDb = db;
  });

  afterEach(() => {
    currentDb = null;
    db.close();
  });

  it('round-trips setter and upsert, then follows a rename into a new row', () => {
    insertSession(db, 'old');
    sessionRepo.setGrokSandbox('old', 'project-locked');
    const stored = sessionRepo.get('old');
    expect(stored?.grokSandbox).toBe('project-locked');

    sessionRepo.upsert({ ...stored!, lifecycle: 'dormant' });
    expect(sessionRepo.get('old')).toMatchObject({
      lifecycle: 'dormant',
      grokSandbox: 'project-locked',
    });

    renameWithDb(db, 'old', 'new');
    expect(sessionRepo.get('old')).toBeNull();
    expect(sessionRepo.get('new')?.grokSandbox).toBe('project-locked');
  });
});
