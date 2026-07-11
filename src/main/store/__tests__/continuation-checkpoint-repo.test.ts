import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContinuationCheckpoint } from '@main/session/continuation-context/checkpoint-schema';
import { createContinuationCheckpointRepo } from '../continuation-checkpoint-repo';
import { bindingAvailable } from './_binding-probe';
import { insertSession, makeMemoryDb } from './agent-deck-repos/_setup';

function checkpoint(
  eventId: number,
  revision: number,
  text = `goal at revision ${revision}`,
): ContinuationCheckpoint {
  return {
    formatVersion: 1,
    goals: [
      {
        id: 'goal.primary',
        status: 'active',
        text,
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

function insertEvent(db: Database.Database, sessionId: string, text: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES (?, 'message', ?, ?)`,
      )
      .run(sessionId, JSON.stringify({ role: 'user', text }), Date.now()).lastInsertRowid,
  );
}

function revisionState(
  db: Database.Database,
  sessionId = 'session-a',
): { revision: number; rebuildAfterRevision: number } {
  return db
    .prepare(
      `SELECT revision, rebuild_after_revision AS rebuildAfterRevision
         FROM session_event_revisions
        WHERE session_id = ?`,
    )
    .get(sessionId) as { revision: number; rebuildAfterRevision: number };
}

describe.skipIf(!bindingAvailable)('continuation checkpoint repository', () => {
  let db: Database.Database;
  let repo: ReturnType<typeof createContinuationCheckpointRepo>;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'session-a');
    repo = createContinuationCheckpointRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('commits canonical JSON with provenance and returns latest/at-or-before heads', () => {
    const event1 = insertEvent(db, 'session-a', 'first');
    const first = repo.commit({
      sessionId: 'session-a',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: event1,
      checkpoint: checkpoint(event1, 1),
      generatorAdapter: 'codex-cli',
      generatorModel: 'gpt-test',
      generatorThinking: 'high',
      trigger: 'handoff',
      inputTokens: 10,
      outputTokens: 20,
      checkpointTokens: 30,
      createdAt: 1000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.checkpoint).toMatchObject({
      generation: 1,
      parentCheckpointId: null,
      sourceEventRevision: 1,
      sourceRebuildAfterRevision: 0,
      sourceMaxEventId: event1,
      generatorAdapter: 'codex-cli',
      generatorModel: 'gpt-test',
      generatorThinking: 'high',
      trigger: 'handoff',
      inputTokens: 10,
      outputTokens: 20,
      checkpointTokens: 30,
      createdAt: 1000,
    });
    expect(first.checkpoint.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(first.checkpoint.payloadJson)).toEqual(first.checkpoint.checkpoint);

    const event2 = insertEvent(db, 'session-a', 'second');
    const second = repo.commit({
      sessionId: 'session-a',
      expectedHeadId: first.checkpoint.id,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 2,
      sourceMaxEventId: event2,
      checkpoint: checkpoint(event2, 2),
      generatorAdapter: 'claude-code',
      generatorModel: null,
      generatorThinking: null,
      trigger: 'recovery',
      createdAt: 2000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.checkpoint).toMatchObject({
      generation: 2,
      parentCheckpointId: first.checkpoint.id,
      sourceEventRevision: 2,
    });
    expect(repo.latest('session-a')?.id).toBe(second.checkpoint.id);
    expect(repo.latestAtOrBefore('session-a', 1)?.id).toBe(first.checkpoint.id);
    expect(repo.latestAtOrBefore('session-a', 0)).toBeNull();
  });

  it('returns explicit CAS, epoch, coverage, and refresh conflicts without writing', () => {
    const event1 = insertEvent(db, 'session-a', 'first');
    const baseInput = {
      sessionId: 'session-a',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: event1,
      checkpoint: checkpoint(event1, 1),
      generatorAdapter: 'codex-cli',
      generatorModel: null,
      generatorThinking: null,
      trigger: 'handoff',
    } as const;
    const first = repo.commit(baseInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(repo.commit(baseInput)).toMatchObject({ ok: false, reason: 'head-changed' });
    expect(
      repo.commit({ ...baseInput, expectedHeadId: first.checkpoint.id }),
    ).toMatchObject({ ok: false, reason: 'same-revision-refresh-not-allowed' });
    const refresh = repo.commit({
      ...baseInput,
      expectedHeadId: first.checkpoint.id,
      allowSameRevisionRefresh: true,
      checkpoint: checkpoint(event1, 1, 'refreshed'),
    });
    expect(refresh.ok).toBe(true);
    if (!refresh.ok) return;

    expect(
      repo.commit({
        ...baseInput,
        expectedHeadId: refresh.checkpoint.id,
        sourceEventRevision: 0,
      }),
    ).toMatchObject({ ok: false, reason: 'coverage-regression' });
    expect(
      repo.commit({
        ...baseInput,
        expectedHeadId: refresh.checkpoint.id,
        sourceEventRevision: revisionState(db).revision + 1,
      }),
    ).toMatchObject({ ok: false, reason: 'source-revision-ahead' });

    db.prepare(`DELETE FROM events WHERE id = ?`).run(event1);
    expect(
      repo.commit({
        ...baseInput,
        expectedHeadId: refresh.checkpoint.id,
        sourceEventRevision: revisionState(db).revision,
      }),
    ).toMatchObject({ ok: false, reason: 'rebuild-epoch-changed' });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
    ).toEqual({ count: 2 });
  });

  it('allows a captured prefix to commit after a later nondestructive event arrives', () => {
    const capturedEvent = insertEvent(db, 'session-a', 'captured');
    insertEvent(db, 'session-a', 'arrived during generation');
    expect(revisionState(db)).toEqual({ revision: 2, rebuildAfterRevision: 0 });

    const result = repo.commit({
      sessionId: 'session-a',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: capturedEvent,
      checkpoint: checkpoint(capturedEvent, 1),
      generatorAdapter: 'codex-cli',
      generatorModel: null,
      generatorThinking: null,
      trigger: 'fold',
    });

    expect(result.ok).toBe(true);
    expect(repo.latest('session-a')?.sourceEventRevision).toBe(1);
  });

  it('rejects invalid schema/evidence before persistence and ignores corrupted stored heads', () => {
    const event1 = insertEvent(db, 'session-a', 'first');
    const invalidEvidence = checkpoint(event1, 2);
    expect(() =>
      repo.commit({
        sessionId: 'session-a',
        expectedHeadId: null,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 1,
        sourceMaxEventId: event1,
        checkpoint: invalidEvidence,
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'handoff',
      }),
    ).toThrow(/beyond source revision/);
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
    ).toEqual({ count: 0 });

    const committed = repo.commit({
      sessionId: 'session-a',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: event1,
      checkpoint: checkpoint(event1, 1),
      generatorAdapter: 'codex-cli',
      generatorModel: null,
      generatorThinking: null,
      trigger: 'handoff',
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    db.prepare(`UPDATE continuation_checkpoints SET content_hash = ? WHERE id = ?`).run(
      'f'.repeat(64),
      committed.checkpoint.id,
    );
    expect(repo.latest('session-a')).toBeNull();

    const replacement = repo.commit({
      sessionId: 'session-a',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: event1,
      checkpoint: checkpoint(event1, 1, 'replacement'),
      generatorAdapter: 'codex-cli',
      generatorModel: null,
      generatorThinking: null,
      trigger: 'refresh',
      allowSameRevisionRefresh: true,
    });
    expect(replacement.ok).toBe(true);
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
    ).toEqual({ count: 1 });
  });

  it('retains the latest three validated generations and invalidates reads after deletion', () => {
    let headId: number | null = null;
    const committed: number[] = [];
    for (let revision = 1; revision <= 5; revision += 1) {
      const eventId = insertEvent(db, 'session-a', `event-${revision}`);
      const result = repo.commit({
        sessionId: 'session-a',
        expectedHeadId: headId,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: revision,
        sourceMaxEventId: eventId,
        checkpoint: checkpoint(eventId, revision),
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'fold',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      headId = result.checkpoint.id;
      committed.push(result.checkpoint.id);
    }

    expect(
      db
        .prepare(
          `SELECT generation FROM continuation_checkpoints
            WHERE session_id = 'session-a' ORDER BY generation`,
        )
        .pluck()
        .all(),
    ).toEqual([3, 4, 5]);
    expect(repo.latest('session-a')?.id).toBe(committed.at(-1));
    expect(repo.latestAtOrBefore('session-a', 2)).toBeNull();

    const latestEventId = db
      .prepare(`SELECT MAX(id) FROM events WHERE session_id = 'session-a'`)
      .pluck()
      .get() as number;
    db.prepare(`DELETE FROM events WHERE id = ?`).run(latestEventId);
    expect(repo.latest('session-a')).toBeNull();
  });

  it('returns session-missing and cascades checkpoints on session deletion', () => {
    expect(
      repo.commit({
        sessionId: 'missing',
        expectedHeadId: null,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 0,
        sourceMaxEventId: null,
        checkpoint: checkpoint(1, 0),
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'handoff',
      }),
    ).toMatchObject({ ok: false, reason: 'session-missing' });

    const event1 = insertEvent(db, 'session-a', 'first');
    const result = repo.commit({
      sessionId: 'session-a',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: event1,
      checkpoint: checkpoint(event1, 1),
      generatorAdapter: 'codex-cli',
      generatorModel: null,
      generatorThinking: null,
      trigger: 'handoff',
    });
    expect(result.ok).toBe(true);
    db.prepare(`DELETE FROM sessions WHERE id = 'session-a'`).run();
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
    ).toEqual({ count: 0 });
  });
});
