import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { bindingAvailable, makeMemoryDb } from './_setup';
import { renameWithDb } from '../rename';

let currentDb: Database.Database | null = null;
vi.mock('../../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('agent profile test DB is not initialized');
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

describe.skipIf(!bindingAvailable)('session Agent runtime profile persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    currentDb = db;
  });

  afterEach(() => {
    currentDb = null;
    db.close();
  });

  it('round-trips through setter/upsert and follows both rename branches', () => {
    insertSession(db, 'old');
    sessionRepo.setAgentRuntimeProfile('old', {
      agentProfileName: 'reviewer-grok',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-grok',
    });

    const stored = sessionRepo.get('old');
    expect(stored).toMatchObject({
      agentProfileName: 'reviewer-grok',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-grok',
    });
    sessionRepo.upsert({ ...stored!, lifecycle: 'dormant' });
    expect(sessionRepo.get('old')).toMatchObject({
      lifecycle: 'dormant',
      agentProfileName: 'reviewer-grok',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-grok',
    });

    renameWithDb(db, 'old', 'new');
    expect(sessionRepo.get('old')).toBeNull();
    expect(sessionRepo.get('new')).toMatchObject({
      agentProfileName: 'reviewer-grok',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-grok',
    });

    insertSession(db, 'replacement');
    sessionRepo.setAgentRuntimeProfile('replacement', {
      agentProfileName: 'project-agent',
      agentProfileSource: 'project',
      agentPluginDir: null,
    });
    renameWithDb(db, 'replacement', 'new');
    expect(sessionRepo.get('new')).toMatchObject({
      agentProfileName: 'project-agent',
      agentProfileSource: 'project',
      agentPluginDir: null,
    });
  });
});
