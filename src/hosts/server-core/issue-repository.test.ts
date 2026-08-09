import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ServerCoreIssueRepository } from './issue-repository';

let database: Database.Database | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

function repository(status = 'open', deletedAt: number | null = null) {
  database = new Database(':memory:');
  database.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      repro TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      source_session_id TEXT,
      cwd TEXT,
      branch_name TEXT,
      logs_ref TEXT,
      resolution_session_id TEXT,
      labels TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      deleted_at INTEGER
    );
    CREATE TABLE issue_appendices (
      id INTEGER PRIMARY KEY,
      issue_id TEXT NOT NULL,
      body TEXT NOT NULL,
      logs_ref TEXT,
      appended_session_id TEXT,
      appended_at INTEGER NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO issues(
      id, title, description, kind, status, severity, labels,
      created_at, updated_at, deleted_at
    ) VALUES ('issue-a', 'Issue', 'Description', 'app-bug', ?, 'medium', '[]', 1, 2, ?)
  `).run(status, deletedAt);
  return new ServerCoreIssueRepository(() => database!, { warn: () => undefined });
}

describe('ServerCoreIssueRepository resolution link', () => {
  it('links only the exact actionable Issue version and advances its timestamp', () => {
    const issues = repository();
    const linked = issues.linkResolutionSession('issue-a', 'session-a', 2);
    expect(linked).toMatchObject({
      resolutionSessionId: 'session-a',
      status: 'in-progress',
    });
    expect(linked!.updatedAt).toBeGreaterThan(2);
    expect(issues.linkResolutionSession('issue-a', 'session-b', 2)).toBeNull();
    expect(issues.get('issue-a')?.resolutionSessionId).toBe('session-a');
  });

  it('does not bind deleted or resolved Issues', () => {
    expect(repository('resolved').linkResolutionSession('issue-a', 'session-a', 2)).toBeNull();
    database?.close();
    database = null;
    expect(repository('open', 4).linkResolutionSession('issue-a', 'session-a', 2)).toBeNull();
  });
});
