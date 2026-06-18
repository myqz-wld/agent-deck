/**
 * v033 migration 单测 — issues 表加 branch_name TEXT NULL。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';
import { createIssueRepo } from '../issue-repo';

type SchemaVersion = 'pre-v033' | 'post-v033';

function makeDbAt(version: SchemaVersion): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (version === 'pre-v033' && migration.version >= 33) break;
    db.exec(migration.sql);
  }
  return db;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', '/repo', ?, 'sdk', 'active', 'idle', 1000, 1000)`,
  ).run(id, `title-${id}`);
}

describe.skipIf(!bindingAvailable)('v033 migration / issues.branch_name', () => {
  it('post-v033 schema can write branch_name through issueRepo', () => {
    const db = makeDbAt('post-v033');
    try {
      insertSession(db, 's1');
      const repo = createIssueRepo(db);
      const issue = repo.create({
        title: 'T',
        description: 'D',
        sourceSessionId: 's1',
        branchName: 'feature/branch-snapshot',
      });

      const row = db
        .prepare(`SELECT branch_name FROM issues WHERE id = ?`)
        .get(issue.id) as { branch_name: string };
      expect(row.branch_name).toBe('feature/branch-snapshot');
      expect(repo.get(issue.id)?.branchName).toBe('feature/branch-snapshot');
    } finally {
      db.close();
    }
  });

  it('v032 to v033 upgrade leaves old issues branch_name NULL', () => {
    const db = makeDbAt('pre-v033');
    try {
      insertSession(db, 's1');
      db.prepare(
        `INSERT INTO issues
         (id, title, description, kind, severity, status, source_session_id,
          labels, created_at, updated_at)
         VALUES ('i-old', 'T', 'D', 'follow-up', 'medium', 'open', 's1', '[]', 1000, 1000)`,
      ).run();

      const v033 = MIGRATIONS.find((migration) => migration.version === 33);
      expect(v033).toBeDefined();
      db.exec(v033!.sql);

      const repo = createIssueRepo(db);
      expect(repo.get('i-old')?.branchName).toBeNull();
    } finally {
      db.close();
    }
  });
});
