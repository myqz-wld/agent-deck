import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { estimateCheckpointBacklog } from '../checkpoint-backlog-estimator';
import { estimateCheckpointBacklogTransactionally } from '../checkpoint-backlog-worker';
import type { ContinuationCheckpoint } from '../checkpoint-schema';

const emptyCheckpoint: ContinuationCheckpoint = {
  formatVersion: 1,
  goals: [],
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

describe.skipIf(!bindingAvailable)('checkpoint backlog estimator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'source');
  });

  afterEach(() => db.close());

  function insert(kind: string, payload: unknown, toolUseId: string | null = null): number {
    return Number(
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
         VALUES ('source', ?, ?, 1, ?)`,
      ).run(kind, JSON.stringify(payload), toolUseId).lastInsertRowid,
    );
  }

  it('counts only normalized rows after the latest validated checkpoint', () => {
    const coveredId = insert('message', { role: 'user', text: 'covered' });
    const committed = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: coveredId,
      checkpoint: emptyCheckpoint,
      generatorAdapter: 'claude-code',
      generatorModel: 'test',
      generatorThinking: 'low',
      trigger: 'test',
    });
    expect(committed.ok).toBe(true);
    insert('thinking', { text: 'excluded' });
    insert('message', { role: 'user', text: 'new intent '.repeat(200) });

    const result = estimateCheckpointBacklog({
      db,
      sessionId: 'source',
      saturationTokens: 48_000,
    });

    expect(result).toMatchObject({
      captureRevision: 3,
      checkpointThroughRevision: 1,
      sourceRows: 2,
      saturated: false,
    });
    expect(result!.estimatedTokens).toBeGreaterThan(0);
  });

  it('uses fold telemetry compaction and byte-identical completed-tool deduplication', () => {
    const toolInput = { command: 'x'.repeat(20_000) };
    insert('tool-use-start', { toolInput }, 'tool-1');
    insert('tool-use-end', { toolInput, result: 'done' }, 'tool-1');

    const result = estimateCheckpointBacklog({
      db,
      sessionId: 'source',
      saturationTokens: 48_000,
    });

    expect(result?.sourceRows).toBe(2);
    expect(result?.estimatedTokens).toBeLessThan(1_000);
  });

  it('saturates conservatively when the source guard is reached', () => {
    insert('message', { role: 'user', text: 'large source evidence' });

    expect(
      estimateCheckpointBacklog({
        db,
        sessionId: 'source',
        saturationTokens: 48_000,
        maxSourceBytes: 1,
      }),
    ).toMatchObject({ estimatedTokens: 48_000, saturated: true });
  });

  it('returns null for a missing session revision state', () => {
    expect(
      estimateCheckpointBacklog({
        db,
        sessionId: 'missing',
        saturationTokens: 48_000,
      }),
    ).toBeNull();
  });

  it('estimates a file-backed WAL database through an isolated read-only snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-backlog-worker-'));
    const path = join(root, 'agent-deck.db');
    const writer = makeMemoryDb(path);
    writer.pragma('journal_mode = WAL');
    insertSession(writer, 'worker-source');
    writer.prepare(
      `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
       VALUES ('worker-source', 'message', ?, 1, NULL)`,
    ).run(JSON.stringify({ role: 'user', text: 'file-backed evidence '.repeat(300) }));
    const reader = new Database(path, { fileMustExist: true, readonly: true });
    try {
      reader.pragma('query_only = ON');
      const result = estimateCheckpointBacklogTransactionally(reader, {
        sessionId: 'worker-source',
        saturationTokens: 48_000,
      });
      expect(result).toMatchObject({
        sessionId: 'worker-source',
        captureRevision: 1,
        rebuildAfterRevision: 0,
        checkpointThroughRevision: 0,
        sourceRows: 1,
        saturated: false,
      });
      expect(result!.estimatedTokens).toBeGreaterThan(0);
      expect(() => reader.prepare('DELETE FROM events').run()).toThrow();
    } finally {
      reader.close();
      writer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
