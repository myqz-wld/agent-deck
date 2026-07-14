import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import {
  createWorkerOwnedBackgroundFoldSource,
  materializeBackgroundCheckpointSource,
  type MaterializedBackgroundCheckpointSource,
} from '../checkpoint-background-materializer';
import { utf8ByteLength } from '../token-estimator';

describe.skipIf(!bindingAvailable)('background checkpoint materializer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'source');
  });

  afterEach(() => db.close());

  function insert(kind: string, payload: unknown, toolUseId: string | null = null): number {
    return Number(db.prepare(
      `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
       VALUES ('source', ?, ?, 1, ?)`,
    ).run(kind, JSON.stringify(payload), toolUseId).lastInsertRowid);
  }

  it('captures only a complete revision prefix under the row guard', () => {
    for (let index = 0; index < 5; index += 1) {
      insert('message', { role: 'user', text: `message-${index}` });
    }

    const source = materializeBackgroundCheckpointSource(db, {
      sessionId: 'source',
      maxRows: 3,
    });

    expect(source.metadata).toMatchObject({
      captureRevision: 5,
      materializedThroughRevision: 3,
      sourceRows: 3,
      groupCount: 3,
      truncatedBy: 'rows',
    });
    expect(source.groups.map((group) => group.revision)).toEqual([1, 2, 3]);
  });

  it('re-normalizes a selected prefix without a later tool end deduplicating its start', async () => {
    insert('tool-use-start', { phase: 'started', toolInput: { command: 'pwd' } }, 'tool-1');
    for (let index = 0; index < 60; index += 1) {
      insert('message', { role: 'user', text: `${index}: ${'x'.repeat(4_000)}` });
    }
    insert(
      'tool-use-end',
      { phase: 'completed', toolInput: { command: 'pwd' }, result: '/repo' },
      'tool-1',
    );
    const materialized = materializeBackgroundCheckpointSource(db, { sessionId: 'source' });
    const source = createWorkerOwnedBackgroundFoldSource(materialized);

    const chunk = await source.buildNextChunk({
      cursor: 0,
      coveredThroughRevision: 0,
      previous: null,
      budget: 8_000,
    });

    expect(chunk).not.toBeNull();
    expect(chunk!.remainingAfter).toBe(true);
    expect(chunk!.prompt).toContain('started');
  });

  it('rebuilds the exact consumed prefix when a candidate suffix completes its tool', async () => {
    insert('tool-use-start', { phase: 'started', toolInput: { command: 'pwd' } }, 'tool-1');
    for (let revision = 2; revision <= 9; revision += 1) {
      insert('message', { role: 'user', text: `${revision}: ${'x'.repeat(4_000)}` });
    }
    insert(
      'tool-use-end',
      { phase: 'completed', toolInput: { command: 'pwd' }, result: '/repo' },
      'tool-1',
    );
    for (let revision = 11; revision <= 20; revision += 1) {
      insert('message', { role: 'user', text: `${revision}: ${'y'.repeat(4_000)}` });
    }
    const materialized = materializeBackgroundCheckpointSource(db, { sessionId: 'source' });
    const source = createWorkerOwnedBackgroundFoldSource(materialized);

    const chunk = await source.buildNextChunk({
      cursor: 0,
      coveredThroughRevision: 0,
      previous: null,
      budget: 8_000,
    });

    expect(materialized.metadata.groupCount).toBe(20);
    expect(chunk).not.toBeNull();
    expect(chunk!.throughRevision).toBeLessThan(10);
    expect(chunk!.remainingAfter).toBe(true);
    expect(
      (chunk!.normalized as Array<{ kind?: string }>).map((event) => event.kind),
    ).toContain('tool-use-start');
    expect(chunk!.prompt).toContain('started');
  });

  it('falls back to an app-built marker when one chunk would exceed the RPC wire guard', async () => {
    const eventId = insert('message', { role: 'user', text: 'x'.repeat(30_000) });
    const materialized = materializeBackgroundCheckpointSource(db, { sessionId: 'source' });
    const source = createWorkerOwnedBackgroundFoldSource(materialized, 4_096);

    const chunk = await source.buildNextChunk({
      cursor: 0,
      coveredThroughRevision: 0,
      previous: null,
      budget: 96_000,
    });

    expect(chunk).toMatchObject({
      consumedGroupCount: 1,
      throughRevision: 1,
      requiresCoverageMarker: true,
      currentEvidence: [{ eventId, revision: 1 }],
    });
    expect(chunk!.coverageMarker?.id).toContain('continuation.coverage-gap.');
    expect(utf8ByteLength(JSON.stringify({ chunk }))).toBeLessThanOrEqual(4_096);
  });

  it('keeps every worker-owned response bounded while searching many groups', async () => {
    for (let index = 0; index < 500; index += 1) {
      insert('message', { role: 'user', text: `${index}:${'界'.repeat(200)}` });
    }
    const materialized: MaterializedBackgroundCheckpointSource =
      materializeBackgroundCheckpointSource(db, { sessionId: 'source' });
    const source = createWorkerOwnedBackgroundFoldSource(materialized, 64 * 1024);

    const chunk = await source.buildNextChunk({
      cursor: 0,
      coveredThroughRevision: 0,
      previous: null,
      budget: 96_000,
    });

    expect(chunk).not.toBeNull();
    expect(chunk!.consumedGroupCount).toBeLessThan(materialized.metadata.groupCount);
    expect(utf8ByteLength(JSON.stringify({ chunk }))).toBeLessThanOrEqual(64 * 1024);
  });
});
