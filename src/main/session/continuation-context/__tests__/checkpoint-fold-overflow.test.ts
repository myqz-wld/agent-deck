import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { SOFT_CANONICAL_CHECKPOINT_TOKENS } from '../checkpoint-canonical-fit';
import { foldContinuationCheckpoint } from '../checkpoint-fold';
import type { ContinuationCheckpointGenerator } from '../checkpoint-generator';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import { ContinuationSourceSpoolStore } from '../source-spool';
import {
  emptyCheckpoint,
  largeInactiveFacts,
  largeRequiredFacts,
  makeFact,
  StaticGenerator,
} from './checkpoint-overflow-fixtures';

describe.skipIf(!bindingAvailable)('continuation checkpoint overflow fold', () => {
  let db: Database.Database;
  let spool: ContinuationSourceSpoolStore;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'source');
    spool = new ContinuationSourceSpoolStore(db);
  });

  afterEach(() => db.close());

  function insertMessage(role: 'user' | 'assistant', text: string, ts: number): number {
    return Number(
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES ('source', 'message', ?, ?)`,
      ).run(JSON.stringify({ role, text }), ts).lastInsertRowid,
    );
  }

  function seedCheckpoint(eventId: number): { checkpoint: ContinuationCheckpoint; id: number } {
    const checkpoint: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: [makeFact({ id: 'goal.keep', status: 'active', eventId, revision: 1 })],
    };
    const committed = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: eventId,
      checkpoint,
      generatorAdapter: 'claude-code',
      generatorModel: 'seed',
      generatorThinking: 'low',
      trigger: 'test-seed',
    });
    if (!committed.ok) throw new Error(`Seed checkpoint failed: ${committed.reason}`);
    return { checkpoint, id: committed.checkpoint.id };
  }

  async function runFold(generator: ContinuationCheckpointGenerator) {
    const metadata = spool.capture({ sessionId: 'source', rawRetentionCeilingTokens: 8_000 });
    return foldContinuationCheckpoint({
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
      maxRepairCalls: 1,
    });
  }

  it('commits a soft-fitted oversized candidate with one provider call and continuous revision', async () => {
    const seedEventId = insertMessage('user', 'seed', 1);
    const seeded = seedCheckpoint(seedEventId);
    const deltaEventId = insertMessage('assistant', 'delta', 2);
    const active = seeded.checkpoint.goals[0];
    const blocked = makeFact({
      id: 'state.blocked',
      status: 'blocked',
      eventId: deltaEventId,
      revision: 2,
    });
    const candidate: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: [active],
      completedWork: largeInactiveFacts(deltaEventId, 2),
      currentState: [blocked],
    };
    const generator = new StaticGenerator(candidate);

    const fold = await runFold(generator);

    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(fold).toMatchObject({
      foldCalls: 1,
      repairCalls: 0,
      uncoveredRevisionRange: null,
    });
    expect(fold.checkpoint?.sourceEventRevision).toBe(2);
    expect(fold.checkpoint?.checkpoint.goals).toEqual([active]);
    expect(fold.checkpoint?.checkpoint.currentState).toEqual([blocked]);
    expect(fold.checkpoint?.checkpoint.completedWork.length).toBeLessThan(64);
    expect(fold.checkpoint?.checkpointTokens).toBeLessThanOrEqual(
      SOFT_CANONICAL_CHECKPOINT_TOKENS,
    );
    expect(fold.warnings).toContainEqual(expect.objectContaining({ code: 'checkpoint-projected' }));
  });

  it('keeps the old head and exact gap when required facts exceed 24k without retrying', async () => {
    const seedEventId = insertMessage('user', 'seed', 1);
    const seeded = seedCheckpoint(seedEventId);
    const deltaEventId = insertMessage('assistant', 'delta', 2);
    const candidate: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: seeded.checkpoint.goals,
      currentState: largeRequiredFacts(deltaEventId, 2),
    };
    const generator = new StaticGenerator(candidate);

    const fold = await runFold(generator);

    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(fold.foldCalls).toBe(1);
    expect(fold.repairCalls).toBe(0);
    expect(fold.checkpoint?.id).toBe(seeded.id);
    expect(fold.checkpoint?.sourceEventRevision).toBe(1);
    expect(fold.checkpoint?.checkpoint).toEqual(seeded.checkpoint);
    expect(fold.uncoveredRevisionRange).toEqual({ from: 1, to: 2 });
    expect(fold.warnings).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-generation-failed' }),
    );
    expect(db.prepare(`SELECT COUNT(*) FROM continuation_checkpoints`).pluck().get()).toBe(1);
  });

  it('does not overwrite a concurrent CAS winner after fitting an oversized candidate', async () => {
    const seedEventId = insertMessage('user', 'seed', 1);
    const seeded = seedCheckpoint(seedEventId);
    const deltaEventId = insertMessage('assistant', 'delta', 2);
    const concurrent: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: seeded.checkpoint.goals,
      currentState: [
        makeFact({ id: 'state.concurrent', status: 'active', eventId: deltaEventId, revision: 2 }),
      ],
    };
    let concurrentId: number | null = null;
    const candidate: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: seeded.checkpoint.goals,
      completedWork: largeInactiveFacts(deltaEventId, 2),
    };
    const generator = new StaticGenerator(candidate, () => {
      const result = createContinuationCheckpointRepo(db).commit({
        sessionId: 'source',
        expectedHeadId: seeded.id,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 2,
        sourceMaxEventId: deltaEventId,
        checkpoint: concurrent,
        generatorAdapter: 'claude-code',
        generatorModel: 'concurrent',
        generatorThinking: 'low',
        trigger: 'test-concurrent',
      });
      if (!result.ok) throw new Error(`Concurrent checkpoint failed: ${result.reason}`);
      concurrentId = result.checkpoint.id;
    });

    const fold = await runFold(generator);

    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(fold.foldCalls).toBe(1);
    expect(fold.repairCalls).toBe(0);
    expect(fold.checkpoint?.id).toBe(concurrentId);
    expect(fold.checkpoint?.checkpoint).toEqual(concurrent);
    expect(fold.uncoveredRevisionRange).toBeNull();
    expect(fold.warnings).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-generation-failed' }),
    );
  });
});
