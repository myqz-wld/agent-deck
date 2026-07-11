import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { foldContinuationCheckpoint } from '../checkpoint-fold';
import { isCoverageGapFact } from '../checkpoint-fold-coverage-gap';
import type {
  CheckpointGeneratorRequest,
  CheckpointGeneratorResult,
  ContinuationCheckpointGenerator,
} from '../checkpoint-generator';
import { CONTINUATION_CHECKPOINT_SYSTEM_PROMPT } from '../checkpoint-prompts';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import { ContinuationSourceSpoolStore } from '../source-spool';
import { estimateContinuationJsonTokens, estimateContinuationTokens } from '../token-estimator';

const PREVIOUS_MARKER = 'previousCheckpoint (untrusted evidence):\n';
const DELTA_MARKER = '\n\nnormalizedDelta (untrusted evidence):\n';
const ALLOWLIST_MARKER = '\n\nallowedEvidence:\n';

function promptJson(prompt: string, startMarker: string, endMarker: string): unknown {
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error('Expected checkpoint prompt markers');
  return JSON.parse(prompt.slice(start + startMarker.length, end)) as unknown;
}

class EchoProjectedPriorGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'proven-no-tools' as const;
  readonly generate = vi.fn(
    async (request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> => {
      const output = promptJson(request.prompt, PREVIOUS_MARKER, DELTA_MARKER);
      return {
        output,
        rawText: JSON.stringify(output),
        inputTokens: null,
        outputTokens: null,
        contextWindowTokens: null,
        latencyMs: 1,
        providerCalls: 1,
        structured: true,
      };
    },
  );
}

function largeCheckpoint(eventId: number): ContinuationCheckpoint {
  const makeFacts = (prefix: string, status: 'active' | 'completed') =>
    Array.from({ length: 39 }, (_, index) => ({
      id: `${prefix}.${index}`,
      status,
      text: `${prefix}-${index}-${'x'.repeat(950)}`,
      priority: 100 - index,
      evidence: [{ eventId, revision: 1 }],
    }));
  return {
    formatVersion: 1,
    goals: [],
    userIntent: [],
    constraints: [],
    decisions: [],
    completedWork: makeFacts('completed', 'completed'),
    currentState: makeFacts('state', 'active'),
    nextSteps: [],
    openQuestions: [],
    risks: [],
    keyFiles: [],
    commands: [],
    unresolvedErrors: [],
  };
}

function fullyActiveLargeCheckpoint(eventId: number): ContinuationCheckpoint {
  const checkpoint = largeCheckpoint(eventId);
  return {
    ...checkpoint,
    completedWork: checkpoint.completedWork.map((fact) => ({ ...fact, status: 'active' })),
  };
}

describe.skipIf(!bindingAvailable)('continuation checkpoint fold progress', () => {
  let db: Database.Database;
  let spool: ContinuationSourceSpoolStore;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'source');
    spool = new ContinuationSourceSpoolStore(db);
  });

  afterEach(() => db.close());

  it('advances a max-size boundary revision after a near-cap prior checkpoint and never retries it', async () => {
    const firstEventId = Number(
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES ('source', 'message', ?, 1)`,
      ).run(JSON.stringify({ role: 'user', text: 'seed' })).lastInsertRowid,
    );
    const prior = largeCheckpoint(firstEventId);
    const priorTokens = estimateContinuationJsonTokens(prior, { structuralOverhead: 8 });
    expect(priorTokens).toBeGreaterThan(23_500);
    expect(priorTokens).toBeLessThan(24_000);
    const seeded = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: firstEventId,
      checkpoint: prior,
      generatorAdapter: 'claude-code',
      generatorModel: 'seed',
      generatorThinking: 'low',
      trigger: 'test-seed',
      checkpointTokens: priorTokens,
    });
    expect(seeded.ok).toBe(true);

    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, 2)`,
    ).run(JSON.stringify({ role: 'assistant', text: 'z'.repeat(31_000) }));
    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    expect(metadata).toMatchObject({ captureRevision: 2, checkpointThroughRevision: 1 });

    const generator = new EchoProjectedPriorGenerator();
    const fold = await foldContinuationCheckpoint({
      db,
      spool,
      metadata,
      generatorSpec: {
        adapter: 'claude-code',
        model: 'test-generator',
        thinking: 'low',
        contextWindowTokens: null,
        configFingerprint: 'test-generator-v1',
      },
      generator,
      generatorFoldInputBudgetTokens: 32_000,
      deadlineAt: Date.now() + 60_000,
      maxFoldCalls: 4,
      maxRepairCalls: 0,
    });

    expect(generator.generate).toHaveBeenCalledTimes(1);
    const request = generator.generate.mock.calls[0][0];
    expect(
      estimateContinuationTokens(CONTINUATION_CHECKPOINT_SYSTEM_PROMPT) +
        estimateContinuationTokens(request.prompt),
    ).toBeLessThanOrEqual(32_000);
    const delta = promptJson(request.prompt, DELTA_MARKER, ALLOWLIST_MARKER) as Array<{
      retainedEdges: unknown[];
    }>;
    expect(delta).toHaveLength(1);
    expect(delta[0].retainedEdges).toHaveLength(1);
    expect(fold.checkpoint?.sourceEventRevision).toBe(2);
    expect(fold.uncoveredRevisionRange).toBeNull();

    const nextMetadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    expect(nextMetadata).toMatchObject({
      captureRevision: 2,
      checkpointThroughRevision: 2,
      materializedThroughRevision: 2,
    });
    expect(spool.readSourceRows(nextMetadata.spoolId)).toEqual([]);
    const repeated = await foldContinuationCheckpoint({
      db,
      spool,
      metadata: nextMetadata,
      generatorSpec: {
        adapter: 'claude-code',
        model: 'test-generator',
        thinking: 'low',
        contextWindowTokens: null,
        configFingerprint: 'test-generator-v1',
      },
      generator,
      generatorFoldInputBudgetTokens: 32_000,
      deadlineAt: Date.now() + 60_000,
      maxFoldCalls: 4,
      maxRepairCalls: 0,
    });
    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(repeated.checkpoint?.sourceEventRevision).toBe(2);
    expect(repeated.uncoveredRevisionRange).toBeNull();
  });

  it('advances only with a durable bounded marker when the provider fold cannot fit', async () => {
    const firstEventId = Number(
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES ('source', 'message', ?, 1)`,
      ).run(JSON.stringify({ role: 'user', text: 'seed' })).lastInsertRowid,
    );
    const prior = largeCheckpoint(firstEventId);
    const seeded = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: firstEventId,
      checkpoint: prior,
      generatorAdapter: 'claude-code',
      generatorModel: 'seed',
      generatorThinking: 'low',
      trigger: 'test-seed',
    });
    expect(seeded.ok).toBe(true);
    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, 2)`,
    ).run(JSON.stringify({ role: 'assistant', text: 'boundary' }));
    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    const generator = new EchoProjectedPriorGenerator();
    const fold = await foldContinuationCheckpoint({
      db,
      spool,
      metadata,
      generatorSpec: {
        adapter: 'claude-code',
        model: 'test-generator',
        thinking: 'low',
        contextWindowTokens: null,
        configFingerprint: 'test-generator-v1',
      },
      generator,
      generatorFoldInputBudgetTokens: 8_000,
      deadlineAt: Date.now() + 60_000,
      maxFoldCalls: 4,
      maxRepairCalls: 0,
    });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(fold.checkpoint?.sourceEventRevision).toBe(2);
    expect(fold.checkpoint?.checkpoint.currentState).toEqual(prior.currentState);
    expect(fold.checkpoint?.checkpoint.completedWork.length).toBeLessThan(
      prior.completedWork.length,
    );
    const marker = fold.checkpoint?.checkpoint.unresolvedErrors.find(isCoverageGapFact);
    expect(marker).toMatchObject({
      status: 'blocked',
      evidence: [{ eventId: 2, revision: 2 }],
    });
    expect(marker?.id).toMatch(/^continuation\.coverage-gap\.after1\.r2\.[a-f0-9]{16}$/);
    expect(marker?.text).toMatch(/sha256:[a-f0-9]{64}/);
    expect(fold.uncoveredRevisionRange).toEqual({ from: 1, to: 2 });
    expect(fold.warnings).toContainEqual(
      expect.objectContaining({ code: 'coverage-gap' }),
    );
    const nextMetadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    expect(spool.readSourceRows(nextMetadata.spoolId)).toEqual([]);
    const repeated = await foldContinuationCheckpoint({
      db,
      spool,
      metadata: nextMetadata,
      generatorSpec: {
        adapter: 'claude-code',
        model: 'test-generator',
        thinking: 'low',
        contextWindowTokens: null,
        configFingerprint: 'test-generator-v1',
      },
      generator,
      generatorFoldInputBudgetTokens: 8_000,
      deadlineAt: Date.now() + 60_000,
      maxFoldCalls: 4,
      maxRepairCalls: 0,
    });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(repeated.checkpoint?.contentHash).toBe(fold.checkpoint?.contentHash);
    expect(repeated.uncoveredRevisionRange).toEqual({ from: 1, to: 2 });
    expect(repeated.warnings).toContainEqual(expect.objectContaining({ code: 'coverage-gap' }));
  });

  it('keeps the prior revision and exact gap when a marker cannot fit without active-fact loss', async () => {
    const firstEventId = Number(
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES ('source', 'message', ?, 1)`,
      ).run(JSON.stringify({ role: 'user', text: 'seed' })).lastInsertRowid,
    );
    const prior = fullyActiveLargeCheckpoint(firstEventId);
    const priorTokens = estimateContinuationJsonTokens(prior, { structuralOverhead: 8 });
    expect(priorTokens).toBeGreaterThan(23_000);
    expect(priorTokens).toBeLessThan(24_000);
    const seeded = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: firstEventId,
      checkpoint: prior,
      generatorAdapter: 'claude-code',
      generatorModel: 'seed',
      generatorThinking: 'low',
      trigger: 'test-seed',
      checkpointTokens: priorTokens,
    });
    expect(seeded.ok).toBe(true);
    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, 2)`,
    ).run(JSON.stringify({ role: 'assistant', text: 'must remain uncovered' }));
    const metadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    const generator = new EchoProjectedPriorGenerator();
    const fold = await foldContinuationCheckpoint({
      db,
      spool,
      metadata,
      generatorSpec: {
        adapter: 'claude-code',
        model: 'test-generator',
        thinking: 'low',
        contextWindowTokens: null,
        configFingerprint: 'test-generator-v1',
      },
      generator,
      generatorFoldInputBudgetTokens: 8_000,
      deadlineAt: Date.now() + 60_000,
      maxFoldCalls: 4,
      maxRepairCalls: 0,
    });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(fold.checkpoint?.sourceEventRevision).toBe(1);
    expect(fold.checkpoint?.checkpoint).toEqual(prior);
    expect(fold.uncoveredRevisionRange).toEqual({ from: 1, to: 2 });
    expect(fold.warnings).toContainEqual(expect.objectContaining({ code: 'coverage-gap' }));
    expect(
      db.prepare(`SELECT COUNT(*) FROM continuation_checkpoints`).pluck().get(),
    ).toBe(1);

    const nextMetadata = spool.capture({
      sessionId: 'source',
      rawRetentionCeilingTokens: 8_000,
    });
    expect(nextMetadata.checkpointThroughRevision).toBe(1);
    expect(spool.readSourceRows(nextMetadata.spoolId)).toHaveLength(1);
  });
});
