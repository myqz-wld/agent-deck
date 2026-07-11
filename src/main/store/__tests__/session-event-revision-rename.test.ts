import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContinuationCheckpoint } from '@main/session/continuation-context/checkpoint-schema';
import { createContinuationCheckpointRepo } from '../continuation-checkpoint-repo';
import { renameWithDb } from '../session-repo/rename';
import { bindingAvailable } from './_binding-probe';
import { insertSession, makeMemoryDb } from './agent-deck-repos/_setup';

interface RevisionRow {
  revision: number;
  rebuild_after_revision: number;
}

function minimalCheckpoint(eventId: number, revision: number): ContinuationCheckpoint {
  return {
    formatVersion: 1,
    goals: [
      {
        id: 'goal.primary',
        status: 'active',
        text: `goal-${revision}`,
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

function revisionState(db: Database.Database, sessionId: string): RevisionRow | undefined {
  return db
    .prepare(
      `SELECT revision, rebuild_after_revision
         FROM session_event_revisions
        WHERE session_id = ?`,
    )
    .get(sessionId) as RevisionRow | undefined;
}

function insertMessage(db: Database.Database, sessionId: string, text: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES (?, 'message', ?, ?)`,
      )
      .run(sessionId, JSON.stringify({ role: 'user', text }), Date.now()).lastInsertRowid,
  );
}

describe.skipIf(!bindingAvailable)('session rename / v037 event revision boundary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('moves events to a missing target and rebuilds beyond the greatest effective revision', () => {
    insertSession(db, 'source');
    const firstId = insertMessage(db, 'source', 'first');
    const secondId = insertMessage(db, 'source', 'second');
    db.prepare(`UPDATE events SET change_revision = 10 WHERE id = ?`).run(secondId);

    renameWithDb(db, 'source', 'target');

    expect(revisionState(db, 'source')).toBeUndefined();
    expect(revisionState(db, 'target')).toEqual({
      revision: 11,
      rebuild_after_revision: 11,
    });
    expect(
      db
        .prepare(
          `SELECT id, session_id, COALESCE(change_revision, id) AS effective_revision
             FROM events
            WHERE session_id = ?
            ORDER BY id`,
        )
        .all('target'),
    ).toEqual([
      { id: firstId, session_id: 'target', effective_revision: 1 },
      { id: secondId, session_id: 'target', effective_revision: 10 },
    ]);
  });

  it('allocates beyond a moved source summary whose revision and rebuild epoch already match', () => {
    insertSession(db, 'source');
    insertSession(db, 'target');
    const sourceEvent = insertMessage(db, 'source', 'source history');
    insertMessage(db, 'target', 'target history');
    db.prepare(`UPDATE events SET change_revision = 10 WHERE id = ?`).run(sourceEvent);
    db.prepare(
      `UPDATE session_event_revisions
          SET revision = 10, rebuild_after_revision = 10
        WHERE session_id = 'source'`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (
         session_id, content, trigger, ts, source_event_revision,
         source_rebuild_after_revision, generation_source
       ) VALUES ('source', 'source-only summary', 'time', 10, 10, 10, 'llm')`,
    ).run();

    renameWithDb(db, 'source', 'target');

    expect(revisionState(db, 'target')).toEqual({
      revision: 11,
      rebuild_after_revision: 11,
    });
    expect(
      db.prepare(
        `SELECT source_event_revision, source_rebuild_after_revision
           FROM summaries WHERE session_id = 'target'`,
      ).get(),
    ).toEqual({
      source_event_revision: 10,
      source_rebuild_after_revision: 10,
    });
  });

  it('advances an existing target once even when moved revisions do not exceed its head', () => {
    insertSession(db, 'source');
    insertSession(db, 'target');
    insertMessage(db, 'source', 'from source');
    insertMessage(db, 'target', 'already there');
    const before = revisionState(db, 'target');

    renameWithDb(db, 'source', 'target');

    expect(before).toEqual({ revision: 1, rebuild_after_revision: 0 });
    expect(revisionState(db, 'target')).toEqual({
      revision: 2,
      rebuild_after_revision: 2,
    });
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM events WHERE session_id = ?`).get('target') as {
        count: number;
      }).count,
    ).toBe(2);
  });

  it.each([
    { targetExists: false, label: 'missing target' },
    { targetExists: true, label: 'existing target' },
  ])('keeps zero-event revision state for a $label', ({ targetExists }) => {
    insertSession(db, 'source');
    if (targetExists) insertSession(db, 'target');

    renameWithDb(db, 'source', 'target');

    expect(revisionState(db, 'source')).toBeUndefined();
    expect(revisionState(db, 'target')).toEqual({
      revision: 1,
      rebuild_after_revision: 1,
    });
  });

  it('invalidates existing target checkpoints and cascades source checkpoints atomically', () => {
    insertSession(db, 'source');
    insertSession(db, 'target');
    const sourceEvent = insertMessage(db, 'source', 'source history');
    const targetEvent = insertMessage(db, 'target', 'target history');
    const checkpoints = createContinuationCheckpointRepo(db);
    expect(
      checkpoints.commit({
        sessionId: 'source',
        expectedHeadId: null,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 1,
        sourceMaxEventId: sourceEvent,
        checkpoint: minimalCheckpoint(sourceEvent, 1),
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'test',
      }).ok,
    ).toBe(true);
    expect(
      checkpoints.commit({
        sessionId: 'target',
        expectedHeadId: null,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 1,
        sourceMaxEventId: targetEvent,
        checkpoint: minimalCheckpoint(targetEvent, 1),
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'test',
      }).ok,
    ).toBe(true);

    renameWithDb(db, 'source', 'target');

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
    ).toEqual({ count: 0 });
    expect(checkpoints.latest('source')).toBeNull();
    expect(checkpoints.latest('target')).toBeNull();
    expect(revisionState(db, 'target')).toEqual({
      revision: 2,
      rebuild_after_revision: 2,
    });
  });

  it('cascades a source checkpoint when the rename creates a missing target', () => {
    insertSession(db, 'source');
    const sourceEvent = insertMessage(db, 'source', 'source history');
    const checkpoints = createContinuationCheckpointRepo(db);
    expect(
      checkpoints.commit({
        sessionId: 'source',
        expectedHeadId: null,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 1,
        sourceMaxEventId: sourceEvent,
        checkpoint: minimalCheckpoint(sourceEvent, 1),
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'test',
      }).ok,
    ).toBe(true);

    renameWithDb(db, 'source', 'target');

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM continuation_checkpoints`).get(),
    ).toEqual({ count: 0 });
    expect(checkpoints.latest('target')).toBeNull();
  });
});
