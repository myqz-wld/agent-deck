import { describe, expect, it } from 'vitest';

import { createTokenUsageRepo } from '../token-usage-repo';
import { makeMemoryDb } from './agent-deck-repos/_setup';
import {
  bindingAvailable,
  insertSession,
  makeRepo,
  usage,
} from './token-usage-repo-test-helpers';

describe.skipIf(!bindingAvailable)('token-usage-repo / 去硬 FK（F3）', () => {
  it('session 删除后 token_usage row 仍保留（无 FK CASCADE/SET NULL）', () => {
    const db = makeMemoryDb(':memory:', 55);
    const repo = createTokenUsageRepo(db);
    insertSession(db, 'sess-x');
    repo.insert(usage({ sessionId: 'sess-x' }));
    db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-x');
    const count = db.prepare(
      'SELECT COUNT(*) AS count FROM token_usage',
    ).get() as { count: number };
    expect(count.count).toBe(1);
    db.close();
  });
});

describe.skipIf(!bindingAvailable)('token-usage-repo / deleteOlderThan (GC)', () => {
  it('deletes exactly 500 expired rows in deterministic oldest-first order', () => {
    const { db, repo } = makeRepo();
    for (let index = 0; index < 500; index += 1) {
      repo.insert(usage({ messageId: `old-${index}`, ts: index + 1 }));
    }
    repo.insert(usage({ messageId: 'new', ts: 9_000 }));

    expect(repo.deleteOlderThan(5_000)).toBe(500);
    const rows = db.prepare(
      'SELECT message_id FROM token_usage ORDER BY ts, id',
    ).all() as Array<{ message_id: string }>;
    expect(rows.map((row) => row.message_id)).toEqual(['new']);
    db.close();
  });

  it('caps a 501-row backlog and drains it across bounded batches', () => {
    const { db, repo } = makeRepo();
    for (let index = 0; index < 501; index += 1) {
      repo.insert(usage({ messageId: `expired-${index}`, ts: index + 1 }));
    }

    expect(repo.deleteOlderThan(5_000)).toBe(500);
    const remaining = db.prepare(
      'SELECT message_id, ts FROM token_usage ORDER BY ts, id',
    ).all() as Array<{ message_id: string; ts: number }>;
    expect(remaining).toEqual([{ message_id: 'expired-500', ts: 501 }]);
    expect(repo.deleteOlderThan(5_000)).toBe(1);
    expect(repo.deleteOlderThan(5_000)).toBe(0);
    db.close();
  });

  it('drains a multi-batch backlog without exceeding the limit', () => {
    const { db, repo } = makeRepo();
    for (let index = 0; index < 1_001; index += 1) {
      repo.insert(usage({ messageId: `backlog-${index}`, ts: index + 1 }));
    }

    expect(repo.deleteOlderThan(5_000)).toBe(500);
    expect(repo.deleteOlderThan(5_000)).toBe(500);
    expect(repo.deleteOlderThan(5_000)).toBe(1);
    expect(repo.deleteOlderThan(5_000)).toBe(0);
    db.close();
  });
});
