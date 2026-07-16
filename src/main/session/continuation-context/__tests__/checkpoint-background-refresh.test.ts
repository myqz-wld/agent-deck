import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import type {
  CheckpointGeneratorRequest,
  CheckpointGeneratorResult,
  ContinuationCheckpointGenerator,
} from '../checkpoint-generator';
import { estimateCheckpointBacklog } from '../checkpoint-backlog-estimator';
import { refreshContinuationCheckpointWithDependencies } from '../checkpoint-background-refresh';
import {
  createWorkerOwnedBackgroundFoldSource,
  materializeBackgroundCheckpointSource,
} from '../checkpoint-background-materializer';
import type { CheckpointBackgroundChunkSource } from '../checkpoint-background-worker-client';
import type { ContinuationCheckpoint } from '../checkpoint-schema';

const emptyCheckpoint: ContinuationCheckpoint = {
  formatVersion: 1,
  goals: [], userIntent: [], constraints: [], decisions: [], completedWork: [], currentState: [],
  nextSteps: [], openQuestions: [], risks: [], keyFiles: [], commands: [], unresolvedErrors: [],
};
const emptyPatch = { formatVersion: 1 as const, additions: [], updates: [] };

class FakeGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'proven-no-tools' as const;
  readonly generate = vi.fn(
    async (_request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> => ({
      output: emptyPatch,
      rawText: JSON.stringify(emptyPatch),
      inputTokens: 100,
      outputTokens: 20,
      contextWindowTokens: 128_000,
      latencyMs: 1,
      providerCalls: 1,
      structured: true,
    }),
  );
}

describe.skipIf(!bindingAvailable)('background checkpoint refresh', () => {
  let db: Database.Database;
  let generator: FakeGenerator;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'source');
    generator = new FakeGenerator();
  });

  afterEach(() => db.close());

  function insert(text: string): number {
    return Number(
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES ('source', 'message', ?, 1)`,
      ).run(JSON.stringify({ role: 'user', text })).lastInsertRowid,
    );
  }

  function snapshot() {
    const estimate = estimateCheckpointBacklog({
      db,
      sessionId: 'source',
      saturationTokens: 48_000,
    })!;
    return {
      sessionId: estimate.sessionId,
      sourceEventRevision: estimate.captureRevision,
      checkpointEventRevision: estimate.checkpointThroughRevision,
      uncheckpointedNormalizedTokens: estimate.estimatedTokens,
      rebuildAfterRevision: estimate.rebuildAfterRevision,
      checkpointCreatedAt: estimate.checkpointCreatedAt,
      saturated: estimate.saturated,
    };
  }

  const generatorSpec = {
    adapter: 'claude-code' as const,
    model: 'test',
    thinking: 'low' as const,
    contextWindowTokens: 128_000,
    configFingerprint: 'test-generator',
  };

  async function openBackgroundSource(
    limits: { maxRows?: number; maxSourceBytes?: number } = {},
  ): Promise<CheckpointBackgroundChunkSource> {
    const source = createWorkerOwnedBackgroundFoldSource(
      materializeBackgroundCheckpointSource(db, { sessionId: 'source', ...limits }),
    );
    return { ...source, close: async () => undefined };
  }

  it('coalesces an in-place tool update that advances while the job is queued', async () => {
    const toolEventId = Number(
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
         VALUES ('source', 'tool-use-start', ?, 1, 'tool-1')`,
      ).run(JSON.stringify({ phase: 'started', toolInput: { command: 'pwd' } })).lastInsertRowid,
    );
    const eligibility = snapshot();
    expect(eligibility.sourceEventRevision).toBe(1);
    db.prepare(
      `UPDATE events
          SET kind = 'tool-use-end', payload_json = ?, ts = 2
        WHERE id = ?`,
    ).run(
      JSON.stringify({ phase: 'completed', toolInput: { command: 'pwd' }, result: '/repo' }),
      toolEventId,
    );

    const result = await refreshContinuationCheckpointWithDependencies(
      { sessionId: 'source', trigger: 'safety', snapshot: eligibility },
      {
        db,
        openBackgroundSource,
        resolveGenerator: () => generatorSpec,
        generatorFactory: () => generator,
      },
    );

    expect(result).toMatchObject({ captureRevision: 2, checkpointThroughRevision: 2 });
    expect(createContinuationCheckpointRepo(db).latest('source')?.sourceEventRevision).toBe(2);
    expect(generator.generate.mock.calls[0][0].prompt).toContain('completed');
    expect(snapshot()).toMatchObject({ sourceEventRevision: 2, checkpointEventRevision: 2 });
  });

  it('treats an already-covered latest revision as successful without a provider call', async () => {
    const eventId = insert('covered');
    const committed = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: eventId,
      checkpoint: emptyCheckpoint,
      generatorAdapter: 'claude-code',
      generatorModel: 'test',
      generatorThinking: 'low',
      trigger: 'test',
    });
    expect(committed.ok).toBe(true);

    const result = await refreshContinuationCheckpointWithDependencies(
      { sessionId: 'source', trigger: 'normal', snapshot: snapshot() },
      {
        db,
        openBackgroundSource,
        resolveGenerator: () => generatorSpec,
        generatorFactory: () => generator,
      },
    );

    expect(result).toMatchObject({ checkpointThroughRevision: 1, refreshed: false });
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('rejects partial progress so the scheduler retries the remaining captured backlog', async () => {
    const largeMessage = 'x'.repeat(40_000);
    for (let index = 0; index < 30; index += 1) {
      insert(`${largeMessage}-${index}`);
    }
    const eligibility = snapshot();

    await expect(
      refreshContinuationCheckpointWithDependencies(
        { sessionId: 'source', trigger: 'safety', snapshot: eligibility },
        {
          db,
          openBackgroundSource,
          resolveGenerator: () => generatorSpec,
          generatorFactory: () => generator,
        },
      ),
    ).rejects.toThrow(/covered revision .* of materialized revision/i);

    expect(generator.generate).toHaveBeenCalledTimes(2);
    expect(createContinuationCheckpointRepo(db).latest('source')?.sourceEventRevision).toBeLessThan(
      eligibility.sourceEventRevision,
    );
  });

  it('commits an honestly bounded prefix while reporting the later capture head', async () => {
    for (let index = 0; index < 5; index += 1) insert(`bounded-${index}`);
    const eligibility = snapshot();

    const result = await refreshContinuationCheckpointWithDependencies(
      { sessionId: 'source', trigger: 'safety', snapshot: eligibility },
      {
        db,
        openBackgroundSource: () => openBackgroundSource({ maxRows: 3 }),
        resolveGenerator: () => generatorSpec,
        generatorFactory: () => generator,
      },
    );

    expect(result).toMatchObject({
      captureRevision: 5,
      materializedThroughRevision: 3,
      checkpointThroughRevision: 3,
      uncoveredRevisionRange: { from: 3, to: 5 },
    });
  });

  it('rejects a resource guard that cannot advance one complete revision', async () => {
    insert('too-large-for-source-guard');

    await expect(refreshContinuationCheckpointWithDependencies(
      { sessionId: 'source', trigger: 'safety', snapshot: snapshot() },
      {
        db,
        openBackgroundSource: () => openBackgroundSource({ maxSourceBytes: 1 }),
        resolveGenerator: () => generatorSpec,
        generatorFactory: () => generator,
      },
    )).rejects.toThrow(/made no revision progress/i);
    expect(generator.generate).not.toHaveBeenCalled();
  });
});
