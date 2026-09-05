/** Shared current-schema task fixture; each test owns its database. */
import type Database from 'better-sqlite3';
import { createTaskRepo, type TaskRepo } from '../task-repo';
import { makeMemoryDb, insertSession } from './agent-deck-repos/_setup';
export { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';

export const DEFAULT_SID = 'sess-default';
export function makeMemoryRepo(): { db: Database.Database; repo: TaskRepo; sid: string } {
  const db = makeMemoryDb();
  insertSession(db, DEFAULT_SID);
  return { db, repo: createTaskRepo(db), sid: DEFAULT_SID };
}

export function insertTeam(db: Database.Database, id: string, name = `team-${id}`): void {
  db.prepare(
    `INSERT INTO agent_deck_teams (id, name, created_at, archived_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(id, name, 1000);
}
