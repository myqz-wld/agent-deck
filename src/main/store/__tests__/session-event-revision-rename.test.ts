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
          `SELECT id, session_id, change_revision AS effective_revision
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

  it('rejects an existing target without mutating either session', () => {
    insertSession(db, 'source');
    insertSession(db, 'target');
    const sourceEvent = insertMessage(db, 'source', 'source history');
    const targetEvent = insertMessage(db, 'target', 'target history');
    const sourceBefore = revisionState(db, 'source');
    const targetBefore = revisionState(db, 'target');

    expect(() => renameWithDb(db, 'source', 'target')).toThrow(
      'Cannot rename session source to existing session target',
    );

    expect(
      db.prepare(
        `SELECT id, session_id FROM events WHERE id IN (?, ?) ORDER BY id`,
      ).all(sourceEvent, targetEvent),
    ).toEqual([
      { id: sourceEvent, session_id: 'source' },
      { id: targetEvent, session_id: 'target' },
    ]);
    expect(revisionState(db, 'source')).toEqual(sourceBefore);
    expect(revisionState(db, 'target')).toEqual(targetBefore);
  });

  it('keeps zero-event revision state when creating the target', () => {
    insertSession(db, 'source');

    renameWithDb(db, 'source', 'target');

    expect(revisionState(db, 'source')).toBeUndefined();
    expect(revisionState(db, 'target')).toEqual({
      revision: 1,
      rebuild_after_revision: 1,
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
