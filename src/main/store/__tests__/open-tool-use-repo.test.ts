import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { bindingAvailable } from './_binding-probe';

const dbHolder = vi.hoisted((): { current: Database.Database | null } => ({
  current: null,
}));

vi.mock('@main/store/db', () => ({
  getDb: () => {
    if (!dbHolder.current) throw new Error('test database is not installed');
    return dbHolder.current;
  },
}));

import { openToolUseRepo } from '../open-tool-use-repo';

describe.skipIf(!bindingAvailable)('openToolUseRepo', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tool_use_id TEXT
      )
    `);
    dbHolder.current = db;
  });

  afterEach(() => {
    dbHolder.current?.close();
    dbHolder.current = null;
  });

  it('returns only starts without a matching tool-use-end and skips malformed payloads', () => {
    const insert = dbHolder.current!.prepare(
      `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(
      'session-a',
      'tool-use-start',
      JSON.stringify({ toolName: 'Bash', toolInput: { command: 'sleep 10' } }),
      1,
      'open-1',
    );
    insert.run(
      'session-a',
      'tool-use-start',
      JSON.stringify({ toolName: 'Read', toolInput: { file_path: '/tmp/a' } }),
      2,
      'closed-1',
    );
    insert.run(
      'session-a',
      'tool-use-end',
      JSON.stringify({ status: 'completed' }),
      3,
      'closed-1',
    );
    insert.run('session-a', 'tool-use-start', '{bad json', 4, 'bad-1');
    insert.run(
      'session-b',
      'tool-use-start',
      JSON.stringify({ toolName: 'Write' }),
      5,
      'other-session',
    );

    expect(openToolUseRepo.listForSession('session-a')).toEqual([
      {
        toolUseId: 'open-1',
        toolName: 'Bash',
        toolInput: { command: 'sleep 10' },
      },
    ]);
  });
});
