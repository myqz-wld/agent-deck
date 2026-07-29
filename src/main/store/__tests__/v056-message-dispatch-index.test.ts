import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

const require = createRequire(import.meta.url);
const production = require(
  '../../../../scripts/benchmarks/agent-deck-message-dispatch-production.cjs',
) as {
  captureProductionDispatch: (
    repoRoot: string,
    targets: string[],
  ) => {
    eligibleSql: string;
    excludingSql: string;
    backoffPlaceholderCount: number;
  };
  explainProduction: (
    db: Database.Database,
    capture: unknown,
    input: { now: number; limit: number; excludeTargets: string[] },
  ) => Record<'eligible' | 'excluding', Array<{ detail: string }>>;
  planDetails: (plan: Array<{ detail: string }>) => string[];
  resultFingerprint: (rows: unknown[]) => string;
  selectProductionRows: (
    db: Database.Database,
    capture: unknown,
    input: { now: number; limit: number; excludeTargets: string[] },
  ) => Record<'eligibleRows' | 'excludingRows', unknown[]>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const now = 1_800_000_000_000;
const excludeTargets = ['target-hot'];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function migrateThrough(db: Database.Database, version: number): void {
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
  db.pragma(`user_version = ${version}`);
}

function insertFixture(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
        reply_to_message_id, delivery_generation, delivery_lease_to_session_id)
     VALUES (?, NULL, 'source', ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
  );
  const tx = db.transaction(() => {
    for (let index = 0; index < 64; index += 1) {
      const terminal = index >= 48;
      const retryBlocked = !terminal && index % 7 === 0;
      insert.run(
        `message-${String(index).padStart(3, '0')}`,
        index < 24 ? 'target-hot' : `target-${index % 5}`,
        `body-${index}`,
        terminal ? 'delivered' : 'pending',
        1_000 + Math.floor(index / 2),
        terminal ? now - 1 : null,
        retryBlocked ? 1 : 0,
        retryBlocked ? now : null,
        index % 3,
      );
    }
  });
  tx();
}

function messageIndexes(db: Database.Database): Array<{ name: string; sql: string | null }> {
  return db.prepare(
    `SELECT name, sql
       FROM sqlite_schema
      WHERE type = 'index' AND tbl_name = 'agent_deck_messages'
      ORDER BY name`,
  ).all() as Array<{ name: string; sql: string | null }>;
}

describe.skipIf(!bindingAvailable)('v056 message dispatch pending-order index', () => {
  it('fails first on V55 temp sorting, then preserves exact production FIFO results without it', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 55);
      insertFixture(db);
      const capture = production.captureProductionDispatch(repoRoot, excludeTargets);
      const input = { now, limit: 16, excludeTargets };
      const beforeRows = production.selectProductionRows(db, capture, input);
      const beforePlans = production.explainProduction(db, capture, input);
      const indexesBefore = messageIndexes(db);

      expect(beforeRows.eligibleRows).toHaveLength(16);
      expect(beforeRows.excludingRows).toHaveLength(1);
      expect(production.planDetails(beforePlans.eligible).join(' ')).toContain(
        'USE TEMP B-TREE FOR ORDER BY',
      );
      expect(production.planDetails(beforePlans.excluding).join(' ')).toContain(
        'USE TEMP B-TREE FOR ORDER BY',
      );

      const migration = MIGRATIONS.find(({ version }) => version === 56);
      expect(migration).toMatchObject({
        version: 56,
        name: 'agent_deck_messages_pending_order',
        execution: 'offline',
        freshInstallSafe: true,
        command: 'migrate:message-dispatch',
      });
      expect(normalizeSql(migration!.sql)).toBe(
        normalizeSql(
          `CREATE INDEX idx_messages_pending_sent_at
             ON agent_deck_messages(status, sent_at)
          WHERE status = 'pending';`,
        ),
      );

      db.exec(migration!.sql);
      const afterRows = production.selectProductionRows(db, capture, input);
      const afterPlans = production.explainProduction(db, capture, input);
      const indexesAfter = messageIndexes(db);

      expect(afterRows).toEqual(beforeRows);
      expect(production.resultFingerprint(afterRows.eligibleRows)).toBe(
        production.resultFingerprint(beforeRows.eligibleRows),
      );
      expect(production.resultFingerprint(afterRows.excludingRows)).toBe(
        production.resultFingerprint(beforeRows.excludingRows),
      );
      expect(indexesAfter).toEqual(expect.arrayContaining(indexesBefore));
      expect(indexesAfter.find(({ name }) => name === 'idx_messages_pending_sent_at'))
        .toMatchObject({
          sql: expect.stringMatching(
            /ON agent_deck_messages\(status, sent_at\)\s+WHERE status = 'pending'/,
          ),
        });
      for (const plan of [afterPlans.eligible, afterPlans.excluding]) {
        const details = production.planDetails(plan).join(' ');
        expect(details).toContain('USING INDEX idx_messages_pending_sent_at');
        expect(details).not.toContain('TEMP B-TREE');
      }
    } finally {
      db.close();
    }
  });
});
