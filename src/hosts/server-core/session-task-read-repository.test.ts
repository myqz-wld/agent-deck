import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerCoreSessionTaskReadRepository } from './session-task-read-repository';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function harness() {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(`
    CREATE TABLE agent_deck_teams (id TEXT PRIMARY KEY, archived_at INTEGER);
    CREATE TABLE agent_deck_team_members (
      team_id TEXT NOT NULL, session_id TEXT NOT NULL, left_at INTEGER, joined_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, team_id TEXT,
      subject TEXT NOT NULL, description TEXT, status TEXT NOT NULL, active_form TEXT,
      priority INTEGER NOT NULL, blocks TEXT NOT NULL, blocked_by TEXT NOT NULL,
      labels TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const warn = vi.fn();
  return {
    database,
    warn,
    repository: new ServerCoreSessionTaskReadRepository(() => database, { warn }),
  };
}

function insertTask(
  database: Database.Database,
  id: string,
  ownerSessionId: string,
  teamId: string | null,
  labels = '[]',
): void {
  database.prepare(
    `INSERT INTO tasks VALUES (?, ?, ?, ?, NULL, 'active', NULL, 5, '[]', '[]', ?, ?, ?)`,
  ).run(
    id,
    ownerSessionId,
    teamId,
    id,
    labels,
    '2026-08-07T00:00:00.000Z',
    '2026-08-07T00:01:00.000Z',
  );
}

describe('ServerCoreSessionTaskReadRepository', () => {
  it('returns caller personal tasks plus active-team tasks only', () => {
    const { database, repository } = harness();
    database.exec(`
      INSERT INTO agent_deck_teams VALUES ('team-active', NULL), ('team-archived', 1);
      INSERT INTO agent_deck_team_members VALUES
        ('team-active', 'session-a', NULL, 2),
        ('team-archived', 'session-a', NULL, 1);
    `);
    insertTask(database, 'personal-a', 'session-a', null);
    insertTask(database, 'personal-b', 'session-b', null);
    insertTask(database, 'team-visible', 'session-b', 'team-active');
    insertTask(database, 'team-hidden', 'session-b', 'team-archived');

    expect(repository.listForSession('session-a', 20).map((task) => task.id).sort()).toEqual([
      'personal-a',
      'team-visible',
    ]);
  });

  it('contains malformed relation data without logging stored values', () => {
    const { database, repository, warn } = harness();
    insertTask(database, 'personal-a', 'session-a', null, '{bad');

    expect(repository.listForSession('session-a', 20)[0].labels).toEqual([]);
    expect(warn).toHaveBeenCalledWith('task relation field is invalid', {
      action: 'task-read',
      field: 'labels',
      outcome: 'invalid',
      source: 'task-storage',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('{bad');
  });
});
