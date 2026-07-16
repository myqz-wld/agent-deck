import { afterEach, describe, expect, it } from 'vitest';
import { invalidateCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { foldContinuationCheckpoint } from '../checkpoint-fold';
import {
  parseGeneratedContinuationCheckpointPatch,
  type CheckpointGeneratorResult,
  type ContinuationCheckpointGenerator,
} from '../checkpoint-generator';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import { createCheckpointGeneratorRuntime } from '../runtime';
import { ContinuationSourceSpoolStore } from '../source-spool';

const runLive = process.env.AGENT_DECK_CODEX_LIVE_SMOKE === '1';

describe('Codex checkpoint live smoke', () => {
  afterEach(() => invalidateCodexInstance());

  it.runIf(runLive)(
    'generates and persists one semantic patch through the hardened app-server runtime',
    async () => {
      const db = makeMemoryDb();
      try {
        insertSession(db, 'source');
        const seedEventId = Number(
          db.prepare(
            `INSERT INTO events (session_id, kind, payload_json, ts)
             VALUES ('source', 'message', ?, 1)`,
          ).run(JSON.stringify({ role: 'user', text: 'Preserve my intent and run typecheck.' }))
            .lastInsertRowid,
        );
        const previous: ContinuationCheckpoint = {
          formatVersion: 1,
          goals: [{
            id: 'goal.preserve-intent',
            status: 'active',
            text: 'Preserve the user intent exactly.',
            priority: 100,
            evidence: [{ eventId: seedEventId, revision: 1 }],
          }],
          userIntent: [],
          constraints: [],
          decisions: [],
          completedWork: [],
          currentState: [],
          nextSteps: [{
            id: 'next.run-typecheck',
            status: 'active',
            text: 'Run pnpm typecheck.',
            validation: 'pnpm typecheck exits zero.',
            priority: 90,
            evidence: [{ eventId: seedEventId, revision: 1 }],
          }],
          openQuestions: [],
          risks: [],
          keyFiles: [],
          commands: [],
          unresolvedErrors: [],
        };
        const seeded = createContinuationCheckpointRepo(db).commit({
          sessionId: 'source',
          expectedHeadId: null,
          expectedRebuildAfterRevision: 0,
          sourceEventRevision: 1,
          sourceMaxEventId: seedEventId,
          checkpoint: previous,
          generatorAdapter: 'codex-cli',
          generatorModel: 'live-seed',
          generatorThinking: 'low',
          trigger: 'live-smoke-seed',
        });
        expect(seeded.ok).toBe(true);

        db.prepare(
          `INSERT INTO events (session_id, kind, payload_json, ts)
           VALUES ('source', 'message', ?, 2)`,
        ).run(JSON.stringify({
          role: 'assistant',
          text: 'Completed pnpm typecheck successfully; it exited with code 0.',
        }));
        const spool = new ContinuationSourceSpoolStore(db);
        const metadata = spool.capture({
          sessionId: 'source',
          rawRetentionCeilingTokens: 8_000,
        });
        const generatorSpec = {
          adapter: 'codex-cli' as const,
          model: null,
          thinking: 'low' as const,
          contextWindowTokens: null,
          configFingerprint: 'codex-live-smoke-patch-v1',
        };
        const runtime = createCheckpointGeneratorRuntime(generatorSpec);
        const outputs: CheckpointGeneratorResult[] = [];
        const generator: ContinuationCheckpointGenerator = {
          isolation: runtime.isolation,
          async generate(request) {
            const result = await runtime.generate(request);
            outputs.push(result);
            return result;
          },
        };

        const fold = await foldContinuationCheckpoint({
          db,
          spool,
          metadata,
          generatorSpec,
          generator,
          generatorFoldInputBudgetTokens: 32_000,
          deadlineAt: Date.now() + 120_000,
          maxFoldCalls: 1,
          maxRepairCalls: 1,
        });

        expect(outputs).toHaveLength(1);
        const patch = parseGeneratedContinuationCheckpointPatch(outputs[0].output);
        expect(patch.additions.length + patch.updates.length).toBeGreaterThan(0);
        expect(fold).toMatchObject({
          refreshed: true,
          foldCalls: 1,
          repairCalls: 0,
          failure: null,
          uncoveredRevisionRange: null,
        });
        expect(fold.checkpoint?.sourceEventRevision).toBe(2);
        expect(fold.checkpoint?.checkpoint.goals).toEqual(previous.goals);
        expect(fold.checkpoint?.checkpoint.nextSteps[0].id).toBe('next.run-typecheck');
        expect(runtime.isolation).toBe('hardened-unattested');
        expect(outputs[0]).toMatchObject({ providerCalls: 1, structured: true });
      } finally {
        db.close();
      }
    },
    130_000,
  );
});
