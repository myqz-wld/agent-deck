import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import {
  insertSession,
  makeMemoryDb,
} from '@main/store/__tests__/agent-deck-repos/_setup';
import { ContinuationSourceSpoolStore } from '../source-spool';

function insertMessage(
  db: Database.Database,
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES (?, 'message', ?, ?)`,
      )
      .run(sessionId, JSON.stringify({ role, text }), Date.now()).lastInsertRowid,
  );
}

function checkpoint(eventId: number, revision: number): ContinuationCheckpoint {
  return {
    formatVersion: 1,
    goals: [
      {
        id: 'goal.primary',
        status: 'active',
        text: 'continue',
        priority: 100,
        evidence: [{ eventId, revision }],
      },
    ],
    userIntent: [],
    constraints: [],
    decisions: [],
    completedWork: [],
    currentState: [],
    nextSteps: [],
    openQuestions: [],
    risks: [],
    keyFiles: [],
    commands: [],
    unresolvedErrors: [],
  };
}

describe.skipIf(!bindingAvailable)('continuation SQLite TEMP source spool', () => {
  let db: Database.Database;
  let spool: ContinuationSourceSpoolStore;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'source');
    spool = new ContinuationSourceSpoolStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('captures revision, runtime, exact delta, and user-only raw tail synchronously', () => {
    const userId = insertMessage(db, 'source', 'user', 'question');
    insertMessage(db, 'source', 'assistant', 'answer');
    db.prepare(`UPDATE sessions SET model = 'model-a', thinking = 'high' WHERE id = 'source'`).run();

    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
      now: 1000,
    });

    expect(metadata).toMatchObject({
      sessionId: 'source',
      captureRevision: 2,
      materializedThroughRevision: 2,
      uncoveredRevisionRange: null,
      checkpoint: null,
      checkpointThroughRevision: 0,
      consumed: false,
      rawScanTruncated: false,
    });
    expect(metadata.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(spool.readSourceRows(metadata.spoolId).map((row) => row.id)).toEqual([userId, userId + 1]);
    expect(spool.readRawInputs(metadata.spoolId)).toEqual([
      expect.objectContaining({ eventId: userId, text: 'question', origin: 'user' }),
    ]);
  });

  it('captures only the delta after a validated checkpoint', () => {
    const first = insertMessage(db, 'source', 'user', 'first');
    const committed = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: first,
      checkpoint: checkpoint(first, 1),
      generatorAdapter: 'codex-cli',
      generatorModel: null,
      generatorThinking: null,
      trigger: 'test',
    });
    expect(committed.ok).toBe(true);
    const second = insertMessage(db, 'source', 'user', 'second');

    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    expect(metadata.checkpoint?.id).toBe(committed.ok ? committed.checkpoint.id : -1);
    expect(metadata.checkpointThroughRevision).toBe(1);
    expect(spool.readSourceRows(metadata.spoolId).map((row) => row.id)).toEqual([second]);
  });

  it('can skip the unrelated raw-user tail for fold-only capture', () => {
    const first = insertMessage(db, 'source', 'user', 'first');

    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
      includeRawTail: false,
    });

    expect(metadata).toMatchObject({
      captureRevision: 1,
      materializedThroughRevision: 1,
      maxEventId: first,
      rawTailTokens: 0,
      rawWarnings: [],
      rawScanTruncated: false,
    });
    expect(spool.readSourceRows(metadata.spoolId).map((row) => row.id)).toEqual([first]);
    expect(spool.readRawInputs(metadata.spoolId)).toEqual([]);
  });

  it('remains exact when unread source rows are updated or deleted after capture', () => {
    const first = insertMessage(db, 'source', 'user', 'before update');
    const second = insertMessage(db, 'source', 'user', 'before delete');
    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });

    db.prepare(`UPDATE events SET payload_json = ?, ts = ts + 1 WHERE id = ?`).run(
      JSON.stringify({ role: 'user', text: 'after update' }),
      first,
    );
    db.prepare(`DELETE FROM events WHERE id = ?`).run(second);

    const captured = spool.readSourceRows(metadata.spoolId);
    expect(captured.map((row) => JSON.parse(row.payloadJson))).toEqual([
      { role: 'user', text: 'before update' },
      { role: 'user', text: 'before delete' },
    ]);
    expect(spool.metadata(metadata.spoolId).captureRevision).toBe(2);
    expect(
      db
        .prepare(`SELECT revision, rebuild_after_revision FROM session_event_revisions WHERE session_id = 'source'`)
        .get(),
    ).toEqual({ revision: 4, rebuild_after_revision: 4 });
  });

  it('does not claim a partial effective-revision group when the byte guard stops capture', () => {
    const insert = db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, ?)`,
    );
    for (let index = 0; index < 600; index += 1) {
      insert.run(JSON.stringify({ role: 'user', text: `row-${index}-${'x'.repeat(40)}` }), index);
    }
    db.prepare(`UPDATE events SET change_revision = 1000 WHERE session_id = 'source'`).run();
    db.prepare(
      `UPDATE session_event_revisions SET revision = 1000 WHERE session_id = 'source'`,
    ).run();

    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
      maxSpoolBytes: 4_096,
    });
    expect(spool.readSourceRows(metadata.spoolId)).toEqual([]);
    expect(metadata.materializedThroughRevision).toBe(0);
    expect(metadata.uncoveredRevisionRange).toEqual({ from: 0, to: 1000 });
    expect(metadata.rawScanTruncated).toBe(true);
  });

  it('advances full materialization through delete-only revisions with no surviving row', () => {
    const id = insertMessage(db, 'source', 'user', 'temporary');
    db.prepare(`DELETE FROM events WHERE id = ?`).run(id);
    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    expect(metadata).toMatchObject({
      captureRevision: 2,
      rebuildAfterRevision: 2,
      materializedThroughRevision: 2,
      uncoveredRevisionRange: null,
    });
    expect(spool.readSourceRows(metadata.spoolId)).toEqual([]);
  });

  it('supports atomic consume, TTL/session cleanup, and LRU byte eviction', () => {
    insertMessage(db, 'source', 'user', 'one');
    const first = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
      now: 1000,
      ttlMs: 100,
    });
    const second = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
      now: 1100,
      ttlMs: 1000,
    });
    expect(spool.markConsumed(second.spoolId)).toBe(true);
    expect(spool.markConsumed(second.spoolId)).toBe(false);
    expect(spool.purgeExpired(1100)).toBe(1);
    expect(() => spool.metadata(first.spoolId)).toThrow(/not found/);

    const third = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
      now: 1200,
    });
    expect(spool.evictToByteLimit(third.spoolBytes)).toBeGreaterThanOrEqual(1);
    spool.cleanupSession('source');
    expect(() => spool.metadata(third.spoolId)).toThrow(/not found/);
  });
});
