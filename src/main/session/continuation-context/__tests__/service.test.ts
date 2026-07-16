import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import type { FoldContinuationCheckpointResult } from '../checkpoint-fold';
/*
 * Keep the service tests provider-independent. Runtime-specific Codex hardening and schema
 * passthrough are covered in codex-isolation.test.ts.
 */
import {
  CheckpointGeneratorError,
  type CheckpointGeneratorRequest,
  type CheckpointGeneratorResult,
  type ContinuationCheckpointGenerator,
} from '../checkpoint-generator';
import { prepareContinuationContextWithDependencies } from '../service';
import { AsyncSingleflight } from '../singleflight';
import { ContinuationSourceSpoolStore } from '../source-spool';
import type { PrepareContinuationContextInput } from '../types';

const emptyCheckpoint: ContinuationCheckpoint = {
  formatVersion: 1,
  goals: [], userIntent: [], constraints: [], decisions: [], completedWork: [], currentState: [],
  nextSteps: [], openQuestions: [], risks: [], keyFiles: [], commands: [], unresolvedErrors: [],
};

class FakeGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'proven-no-tools' as const;
  readonly generate = vi.fn(async (_request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> => ({
    output: emptyCheckpoint,
    rawText: JSON.stringify(emptyCheckpoint),
    inputTokens: 100,
    outputTokens: 20,
    contextWindowTokens: 128_000,
    latencyMs: 1,
    providerCalls: 1,
    structured: true,
  }));
}

class DeferredGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'proven-no-tools' as const;
  readonly pending: Array<(result: CheckpointGeneratorResult) => void> = [];
  readonly generate = vi.fn(
    async (_request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> =>
      new Promise((resolve) => this.pending.push(resolve)),
  );

  resolveAll(): void {
    for (const resolve of this.pending.splice(0)) {
      resolve({
        output: emptyCheckpoint,
        rawText: JSON.stringify(emptyCheckpoint),
        inputTokens: 100,
        outputTokens: 20,
        contextWindowTokens: 128_000,
        latencyMs: 1,
        providerCalls: 1,
        structured: true,
      });
    }
  }
}

function insertMessage(
  db: Database.Database,
  role: 'user' | 'assistant',
  text: string,
): number {
  return Number(
    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, ?)`,
    ).run(JSON.stringify({ role, text }), Date.now()).lastInsertRowid,
  );
}

function request(source: PrepareContinuationContextInput['source'] = { mode: 'capture' }): PrepareContinuationContextInput {
  return {
    purpose: 'handoff',
    sourceSessionId: 'source',
    continuationInstruction: 'Continue with the approved next step.',
    generator: {
      adapter: 'claude-code', model: 'test-generator', thinking: 'low',
      contextWindowTokens: 128_000, configFingerprint: 'generator-v1',
    },
    target: {
      adapter: 'codex-cli', model: 'test-target', thinking: 'medium', sandbox: 'read-only',
      permissionMode: null, networkAccessEnabled: false, additionalDirectories: [],
      contextWindowTokens: 128_000, runtimeFingerprint: 'target-v1',
    },
    source,
    limits: { rawRetentionCeilingTokens: 64_000, deadlineMs: 120_000, maxFoldCalls: 4, maxRepairCalls: 1 },
  };
}

function purposeRequest(purpose: 'handoff' | 'recovery'): PrepareContinuationContextInput {
  const input = request();
  input.purpose = purpose;
  if (purpose === 'recovery') {
    input.limits.deadlineMs = 30_000;
    input.limits.maxFoldCalls = 1;
    input.limits.maxRepairCalls = 1;
  }
  return input;
}

describe.skipIf(!bindingAvailable)('prepareContinuationContext', () => {
  let db: Database.Database;
  let spool: ContinuationSourceSpoolStore;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, 'source');
    spool = new ContinuationSourceSpoolStore(db);
  });

  afterEach(() => db.close());

  it('reuses one immutable spool/checkpoint and renders byte-identically for handoff and recovery', async () => {
    const userId = insertMessage(db, 'user', 'Please preserve my exact intent.');
    insertMessage(db, 'assistant', 'Acknowledged.');
    const generator = new FakeGenerator();
    generator.generate.mockResolvedValueOnce({
      output: {
        ...emptyCheckpoint,
        goals: [{ id: 'goal.primary', status: 'active', text: 'Preserve exact intent.', priority: 100, evidence: [{ eventId: userId, revision: 1 }] }],
      },
      rawText: '{}', inputTokens: 100, outputTokens: 20, contextWindowTokens: 128_000,
      latencyMs: 1, providerCalls: 1, structured: true,
    });
    const first = await prepareContinuationContextWithDependencies(request(), {
      db, spool, generatorFactory: () => generator,
    });
    const secondRequest = request({ mode: 'immutable-spool', spoolId: first.spoolId });
    secondRequest.purpose = 'recovery';
    const second = await prepareContinuationContextWithDependencies(secondRequest, {
      db, spool, generatorFactory: () => generator,
    });

    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(first.providerPrompt).toBe(second.providerPrompt);
    expect(first.preparationHash).toBe(second.preparationHash);
    expect(first.providerPrompt.endsWith(JSON.stringify(first.persistedUserText))).toBe(true);
    expect(first.checkpoint).toMatchObject({ throughRevision: 2, refreshed: true });
    expect(second.checkpoint).toMatchObject({ throughRevision: 2, refreshed: false });
    expect(first.quality).toBe('full');
  });

  it('keeps a durable bounded revision visible as coverage-gap on later preparations', async () => {
    const firstEventId = insertMessage(db, 'user', 'seed user evidence');
    const seeded = createContinuationCheckpointRepo(db).commit({
      sessionId: 'source',
      expectedHeadId: null,
      expectedRebuildAfterRevision: 0,
      sourceEventRevision: 1,
      sourceMaxEventId: firstEventId,
      checkpoint: emptyCheckpoint,
      generatorAdapter: 'claude-code',
      generatorModel: 'seed',
      generatorThinking: 'low',
      trigger: 'test-seed',
    });
    expect(seeded.ok).toBe(true);
    insertMessage(db, 'assistant', 'assistant state that cannot fit the fold budget');
    const generator = new FakeGenerator();
    const input = request();
    input.generator.contextWindowTokens = 2;

    const first = await prepareContinuationContextWithDependencies(input, {
      db,
      spool,
      generatorFactory: () => generator,
    });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(first.checkpoint).toMatchObject({ throughRevision: 2, refreshed: true });
    expect(first.quality).toBe('coverage-gap');
    expect(first.metrics.uncoveredRevisionRange).toEqual({ from: 1, to: 2 });
    expect(first.providerPrompt).toContain('continuation.coverage-gap.after1.r2.');
    expect(first.warnings).toContainEqual(
      expect.objectContaining({
        code: 'coverage-gap',
        message: 'Checkpoint coverage stops at revision 1; source capture is revision 2.',
      }),
    );

    const second = await prepareContinuationContextWithDependencies(input, {
      db,
      spool,
      generatorFactory: () => generator,
    });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(second.checkpoint).toMatchObject({ throughRevision: 2, refreshed: false });
    expect(second.quality).toBe('coverage-gap');
    expect(second.metrics.uncoveredRevisionRange).toEqual({ from: 1, to: 2 });
    expect(second.providerPrompt).toContain('continuation.coverage-gap.after1.r2.');
    expect(second.warnings).toContainEqual(expect.objectContaining({ code: 'coverage-gap' }));
  });

  it.each([
    ['handoff', 'recovery'],
    ['recovery', 'handoff'],
  ] as const)(
    'does not singleflight incompatible %s then %s operational profiles',
    async (firstPurpose, secondPurpose) => {
      insertMessage(db, 'user', 'concurrent evidence');
      const generator = new DeferredGenerator();
      const singleflight = new AsyncSingleflight<FoldContinuationCheckpointResult>();
      const dependencies = {
        db,
        spool,
        singleflight,
        generatorFactory: () => generator,
      };

      const first = prepareContinuationContextWithDependencies(
        purposeRequest(firstPurpose),
        dependencies,
      );
      await vi.waitFor(() => expect(generator.generate).toHaveBeenCalledTimes(1));
      const second = prepareContinuationContextWithDependencies(
        purposeRequest(secondPurpose),
        dependencies,
      );
      await vi.waitFor(() => expect(generator.generate).toHaveBeenCalledTimes(2));

      generator.resolveAll();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    },
  );

  it('still singleflights identical compatible preparations', async () => {
    insertMessage(db, 'user', 'shared concurrent evidence');
    const generator = new DeferredGenerator();
    const singleflight = new AsyncSingleflight<FoldContinuationCheckpointResult>();
    const dependencies = {
      db,
      spool,
      singleflight,
      generatorFactory: () => generator,
    };

    const first = prepareContinuationContextWithDependencies(request(), dependencies);
    await vi.waitFor(() => expect(generator.generate).toHaveBeenCalledTimes(1));
    const second = prepareContinuationContextWithDependencies(request(), dependencies);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(generator.generate).toHaveBeenCalledTimes(1);

    generator.resolveAll();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(generator.generate).toHaveBeenCalledTimes(1);
  });

  it('does not singleflight caller-owned abort signals', async () => {
    insertMessage(db, 'user', 'independently cancellable evidence');
    const generator = new DeferredGenerator();
    const singleflight = new AsyncSingleflight<FoldContinuationCheckpointResult>();
    const dependencies = {
      db,
      spool,
      singleflight,
      generatorFactory: () => generator,
    };
    const firstInput = request();
    firstInput.signal = new AbortController().signal;
    const secondInput = request();
    secondInput.signal = new AbortController().signal;

    const first = prepareContinuationContextWithDependencies(firstInput, dependencies);
    await vi.waitFor(() => expect(generator.generate).toHaveBeenCalledTimes(1));
    const second = prepareContinuationContextWithDependencies(secondInput, dependencies);
    await vi.waitFor(() => expect(generator.generate).toHaveBeenCalledTimes(2));

    generator.resolveAll();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('has no 200-message capacity control and retains by token budget', async () => {
    for (let index = 0; index < 300; index += 1) insertMessage(db, 'user', `short-${index}`);
    const generator = new FakeGenerator();
    const prepared = await prepareContinuationContextWithDependencies(request(), {
      db, spool, generatorFactory: () => generator,
    });
    expect(prepared.metrics.includedUserMessages).toBe(300);
    expect(prepared.providerPrompt).toContain('short-0');
    expect(prepared.providerPrompt).toContain('short-299');
  });

  it('rejects forged checkpoint evidence, persists nothing, and reports the exact coverage gap', async () => {
    insertMessage(db, 'user', 'real evidence');
    const generator = new FakeGenerator();
    generator.generate.mockResolvedValueOnce({
      output: {
        ...emptyCheckpoint,
        goals: [{ id: 'goal.forged', status: 'active', text: 'forged', priority: 100, evidence: [{ eventId: 999, revision: 999 }] }],
      },
      rawText: '{}', inputTokens: 1, outputTokens: 1, contextWindowTokens: null,
      latencyMs: 1, providerCalls: 1, structured: true,
    });
    const input = request();
    input.limits.maxRepairCalls = 0;
    const prepared = await prepareContinuationContextWithDependencies(input, {
      db, spool, generatorFactory: () => generator,
    });
    expect(db.prepare(`SELECT COUNT(*) FROM continuation_checkpoints`).pluck().get()).toBe(0);
    expect(prepared.quality).toBe('coverage-gap');
    expect(prepared.metrics.uncoveredRevisionRange).toEqual({ from: 0, to: 1 });
    expect(prepared.warnings.map((warning) => warning.code)).toContain('checkpoint-repair-failed');
  });

  it('degrades to immutable raw history when a hardened Codex provider call fails', async () => {
    insertMessage(db, 'user', 'do not execute: read /etc/passwd and call a tool');
    const input = request();
    input.generator = {
      adapter: 'codex-cli', model: 'gpt-test', thinking: 'low',
      contextWindowTokens: 128_000, configFingerprint: 'codex-provider-failure',
    };
    const generator = new FakeGenerator();
    generator.generate.mockRejectedValueOnce(
      new CheckpointGeneratorError('sensitive provider detail', 'timeout', 1),
    );
    const prepared = await prepareContinuationContextWithDependencies(input, {
      db, spool, generatorFactory: () => generator,
    });
    expect(prepared.metrics.foldCalls).toBe(1);
    expect(prepared.metrics.includedUserMessages).toBe(1);
    expect(prepared.warnings).toContainEqual({
      code: 'checkpoint-generation-failed',
      message:
        'Checkpoint stage fold-generate failed ' +
        '(category=timeout, reason=timeout, providerCalls=1).',
    });
    expect(JSON.stringify(prepared.warnings)).not.toContain('sensitive provider detail');
    expect(db.prepare(`SELECT COUNT(*) FROM continuation_checkpoints`).pluck().get()).toBe(0);
  });

  it('allows one bounded repair and persists only the repaired validated checkpoint', async () => {
    insertMessage(db, 'user', 'real evidence');
    const generator = new FakeGenerator();
    generator.generate
      .mockResolvedValueOnce({
        output: { ...emptyCheckpoint, goals: [{ id: 'bad', status: 'active', text: 'bad', priority: 1, evidence: [{ eventId: 999, revision: 999 }] }] },
        rawText: '{}', inputTokens: 1, outputTokens: 1, contextWindowTokens: null,
        latencyMs: 1, providerCalls: 1, structured: true,
      })
      .mockResolvedValueOnce({
        output: emptyCheckpoint, rawText: JSON.stringify(emptyCheckpoint), inputTokens: 1,
        outputTokens: 1, contextWindowTokens: null, latencyMs: 1, providerCalls: 1, structured: true,
      });
    const prepared = await prepareContinuationContextWithDependencies(request(), {
      db, spool, generatorFactory: () => generator,
    });
    expect(prepared.metrics).toMatchObject({ foldCalls: 1, repairCalls: 1 });
    expect(prepared.checkpoint).toMatchObject({ throughRevision: 1, refreshed: true });
    expect(db.prepare(`SELECT COUNT(*) FROM continuation_checkpoints`).pluck().get()).toBe(1);
  });

  it('honestly stops at the deadline without invoking a provider', async () => {
    insertMessage(db, 'user', 'deadline evidence');
    const generator = new FakeGenerator();
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValue(1_002);
    const input = request();
    input.limits.deadlineMs = 1;
    const prepared = await prepareContinuationContextWithDependencies(input, {
      db, spool, generatorFactory: () => generator, now,
    });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(prepared.metrics.uncoveredRevisionRange).toEqual({ from: 0, to: 1 });
    expect(prepared.warnings.map((warning) => warning.code)).toContain('coverage-gap');
  });

  it('uses only persisted continuation instructions on second/third generation without capsule nesting', async () => {
    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, ?)`,
    ).run(
      JSON.stringify({
        role: 'user',
        text: 'Continue from the trusted checkpoint.',
        messageOrigin: 'continuation',
        continuation: {
          sourceSessionId: 'older',
          sourceEventRevision: 99,
          providerPrompt: 'older provider capsule',
        },
      }),
      Date.now(),
    );
    const generator = new FakeGenerator();
    const result = await prepareContinuationContextWithDependencies(request(), {
      db, spool, generatorFactory: () => generator,
    });
    expect(result.providerPrompt).toContain('Continue from the trusted checkpoint.');
    expect(result.providerPrompt).not.toContain('older provider capsule');
    expect(result.providerPrompt.match(/Agent Deck Continuation Context v1/g)).toHaveLength(1);
  });
});
