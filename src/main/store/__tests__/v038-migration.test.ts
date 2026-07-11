import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

function makeV037Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > 37) break;
    db.exec(migration.sql);
  }
  return db;
}

function migrationV038(): string {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 38);
  expect(migration).toEqual(
    expect.objectContaining({ version: 38, name: 'continuation_checkpoints' }),
  );
  return migration!.sql;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', 'active', 'idle', 1000, 1000)`,
  ).run(id, `title-${id}`);
}

describe.skipIf(!bindingAvailable)('v038 migration / continuation checkpoints', () => {
  it('is registered immediately after v037 and creates the validated derived-state table', () => {
    const v037Index = MIGRATIONS.findIndex((migration) => migration.version === 37);
    const v038Index = MIGRATIONS.findIndex((migration) => migration.version === 38);
    expect(v038Index).toBe(v037Index + 1);

    const db = makeV037Db();
    try {
      db.exec(migrationV038());
      const columns = db.prepare(`PRAGMA table_info('continuation_checkpoints')`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'session_id',
        'generation',
        'parent_checkpoint_id',
        'format_version',
        'source_event_revision',
        'source_rebuild_after_revision',
        'source_max_event_id',
        'payload_json',
        'content_hash',
        'generator_adapter',
        'generator_model',
        'generator_thinking',
        'trigger',
        'input_tokens',
        'output_tokens',
        'checkpoint_tokens',
        'created_at',
      ]);
      expect(columns.find((column) => column.name === 'payload_json')?.notnull).toBe(1);

      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list('continuation_checkpoints')`)
        .all() as Array<{ from: string; table: string; on_delete: string }>;
      expect(foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'session_id', table: 'sessions', on_delete: 'CASCADE' }),
          expect.objectContaining({
            from: 'parent_checkpoint_id',
            table: 'continuation_checkpoints',
            on_delete: 'SET NULL',
          }),
        ]),
      );
      expect(
        db
          .prepare(
            `SELECT sql FROM sqlite_master
              WHERE type = 'index' AND name = 'idx_continuation_checkpoints_session_revision'`,
          )
          .pluck()
          .get(),
      ).toContain('source_event_revision DESC');
    } finally {
      db.close();
    }
  });

  it('enforces JSON validity and cascades derived rows with the session', () => {
    const db = makeV037Db();
    try {
      db.exec(migrationV038());
      insertSession(db, 'session-a');
      const insert = db.prepare(
        `INSERT INTO continuation_checkpoints (
           session_id, generation, parent_checkpoint_id, format_version,
           source_event_revision, source_rebuild_after_revision, source_max_event_id,
           payload_json, content_hash, generator_adapter, generator_model,
           generator_thinking, trigger, input_tokens, output_tokens,
           checkpoint_tokens, created_at
         ) VALUES ('session-a', 1, NULL, 1, 0, 0, NULL, ?, ?,
                   'codex-cli', NULL, NULL, 'test', NULL, NULL, NULL, 1000)`,
      );
      expect(() => insert.run('{not-json', '0'.repeat(64))).toThrow();
      insert.run('{}', '0'.repeat(64));
      expect(
        db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
      ).toEqual({ count: 1 });

      db.prepare(`DELETE FROM sessions WHERE id = 'session-a'`).run();
      expect(
        db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
