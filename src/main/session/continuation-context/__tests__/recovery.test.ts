import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import type { SessionRecord } from '@shared/types';
import { isTrustedContinuationInitialTurn } from '../initial-turn';
import { ContinuationSourceSpoolStore } from '../source-spool';
import type { PreparedContinuationContext } from '../types';

const state = vi.hoisted(() => ({ db: null as Database.Database | null }));
const prepareContinuationContext = vi.hoisted(() => vi.fn());
const settingsGet = vi.hoisted(() =>
  vi.fn((key: string) => {
    if (key === 'continuationCheckpointAdapter') return 'claude-code';
    if (key === 'continuationCheckpointRuntimeProvider') return '';
    if (key === 'continuationCheckpointModel') return 'generator-model';
    if (key === 'continuationCheckpointThinking') return 'high';
    if (key === 'continuationRawRetentionTokens') return 64_000;
    return undefined;
  }),
);

vi.mock('@main/store/db', () => ({
  getDb: () => {
    if (!state.db) throw new Error('test db missing');
    return state.db;
  },
}));
vi.mock('@main/store/settings-store', () => ({ settingsStore: { get: settingsGet } }));
vi.mock('../service', () => ({ prepareContinuationContext }));

import {
  captureRecoveryContinuation,
  cleanupRecoveryContinuation,
  prepareRecoveryContinuation,
} from '../recovery';

function session(): SessionRecord {
  return {
    id: 'source',
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'source',
    source: 'sdk',
    lifecycle: 'dormant',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    permissionMode: 'plan',
    claudeCodeSandbox: 'workspace-write',
    model: 'target-model',
    thinking: 'medium',
    extraAllowWrite: ['/parent'],
  };
}

function prepared(spoolId: string): PreparedContinuationContext {
  return {
    version: 1,
    providerPrompt: 'trusted provider prompt',
    persistedUserText: 'continue now',
    source: { eventRevision: 1, rebuildAfterRevision: 0, maxEventId: 1 },
    checkpoint: { id: null, throughRevision: 0, formatVersion: 1, refreshed: false },
    projection: { canonicalHash: null, omittedFacts: 0 },
    quality: 'raw-only',
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 104_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 100,
      checkpointTokens: 0,
      rawTailTokens: 20,
      includedUserMessages: 1,
      truncatedBoundaryMessages: 0,
      foldCalls: 1,
      repairCalls: 0,
      elapsedMs: 1,
      uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: 'a'.repeat(64),
    spoolId,
  };
}

describe.skipIf(!bindingAvailable)('recovery continuation coordinator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    state.db = db;
    insertSession(db, 'source');
    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, 1)`,
    ).run(JSON.stringify({ role: 'user', text: 'historical input' }));
    prepareContinuationContext.mockReset();
    settingsGet.mockClear();
  });

  afterEach(() => {
    state.db = null;
    db.close();
  });

  it('captures the immutable spool and complete target snapshot synchronously', () => {
    const capture = captureRecoveryContinuation({
      session: session(),
      overrides: { cwd: '/fallback', permissionMode: 'acceptEdits' },
    });
    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, 2)`,
    ).run(JSON.stringify({ role: 'user', text: 'current input' }));

    const metadata = new ContinuationSourceSpoolStore(db).metadata(capture.spoolId);
    expect(metadata.captureRevision).toBe(1);
    expect(capture.generator).toMatchObject({
      adapter: 'claude-code', model: 'generator-model', thinking: 'high',
    });
    expect(capture.target).toMatchObject({
      adapter: 'claude-code', model: 'target-model', thinking: 'medium',
      permissionMode: 'acceptEdits',
    });
    expect(capture.target.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(settingsGet).not.toHaveBeenCalledWith('resumeRecentMessagesCount');
    expect(settingsGet).toHaveBeenCalledWith('continuationRawRetentionTokens');
    cleanupRecoveryContinuation(capture);
  });

  it('uses the shared recovery core with exact limits and returns a branded turn', async () => {
    const capture = captureRecoveryContinuation({ session: session() });
    prepareContinuationContext.mockResolvedValueOnce(prepared(capture.spoolId));

    const result = await prepareRecoveryContinuation({
      capture,
      continuationInstruction: 'continue now',
    });

    expect(prepareContinuationContext).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'recovery',
      sourceSessionId: 'source',
      continuationInstruction: 'continue now',
      generator: capture.generator,
      target: capture.target,
      source: { mode: 'immutable-spool', spoolId: capture.spoolId },
      limits: {
        rawRetentionCeilingTokens: 64_000,
        deadlineMs: 30_000,
        maxFoldCalls: 1,
        maxRepairCalls: 1,
      },
    }));
    expect(isTrustedContinuationInitialTurn(result.turn)).toBe(true);
    expect(result.turn.providerPrompt).toBe('trusted provider prompt');
    expect(result.turn.persistedUserText).toBe('continue now');

    cleanupRecoveryContinuation(capture);
    expect(() => new ContinuationSourceSpoolStore(db).metadata(capture.spoolId)).toThrow(/not found/);
  });
});
