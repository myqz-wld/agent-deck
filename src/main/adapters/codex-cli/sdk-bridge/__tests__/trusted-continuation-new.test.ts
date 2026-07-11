import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/session/manager', () => ({
  sessionManager: { claimAsSdk: vi.fn() },
}));
vi.mock('../session-finalize', () => ({
  persistSessionFields: vi.fn(),
}));
vi.mock('@main/codex-config/toml-writer', () => ({
  readTopLevelModelFromCodexConfig: vi.fn(() => null),
}));

import { runCreateSessionNewPath } from '../create-session/create-session-new';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { PreparedContinuationContext } from '@main/session/continuation-context/types';

const prepared: PreparedContinuationContext = {
  version: 1,
  providerPrompt: 'FULL CODEX PROVIDER CONTEXT',
  persistedUserText: 'Persist only this instruction.',
  source: { eventRevision: 12, rebuildAfterRevision: 0, maxEventId: 12 },
  checkpoint: { id: 5, throughRevision: 12, formatVersion: 1, refreshed: true },
  projection: { canonicalHash: 'a'.repeat(64), omittedFacts: 0 },
  quality: 'full',
  metrics: {
    rawRetentionCeilingTokens: 64_000, targetPromptCapacityTokens: 100_000,
    checkpointProjectionBudgetTokens: 12_000, generatorFoldInputBudgetTokens: 32_000,
    estimatedPromptTokens: 100, checkpointTokens: 20, rawTailTokens: 20,
    includedUserMessages: 2, truncatedBoundaryMessages: 0, foldCalls: 1, repairCalls: 0,
    elapsedMs: 1, uncoveredRevisionRange: null,
  },
  warnings: [], preparationHash: 'b'.repeat(64), spoolId: 'spool',
};

describe('Codex trusted continuation new-session split', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends provider context to the turn while emitting only instruction and lineage', async () => {
    const emit = vi.fn();
    const startNewThreadAndAwaitId = vi.fn(async () => 'real-id');
    const internal = {
      applicationSid: 'temp-id',
      threadId: null,
      cwd: '/repo',
      thread: {},
      pendingMessages: ['FULL CODEX PROVIDER CONTEXT'],
      currentTurn: null,
      currentTurnId: null,
      turnLoopRunning: false,
      intentionallyClosed: false,
    };
    const turn = createTrustedContinuationInitialTurn(prepared, 'source-id');
    const result = await runCreateSessionNewPath(
      {
        cwd: '/repo',
        prompt: turn.providerPrompt,
        trustedContinuation: turn,
        codexSandbox: 'read-only',
        awaitCanonicalId: true,
      },
      { cwd: '/repo', sandboxMode: 'read-only', thread: {} as never, internal: internal as never },
      { initialSid: 'temp-id', sessionToken: 'token' },
      {
        sessions: new Map(),
        codexBySession: new Map(),
        threadLoop: { startNewThreadAndAwaitId } as never,
        emit,
        ensureCodex: vi.fn() as never,
      },
    );
    expect(result.sessionId).toBe('real-id');
    expect(startNewThreadAndAwaitId).toHaveBeenCalledWith(
      internal,
      'temp-id',
      '/repo',
      'FULL CODEX PROVIDER CONTEXT',
      undefined,
      undefined,
      { initialSessionEmitted: true, rejectOnFallback: true },
    );
    const message = emit.mock.calls.map(([event]) => event).find((event) => event.kind === 'message');
    expect(message.payload).toMatchObject({
      text: 'Persist only this instruction.',
      role: 'user',
      messageOrigin: 'continuation',
      continuation: { sourceSessionId: 'source-id', checkpointId: 5, sourceEventRevision: 12 },
    });
    expect(JSON.stringify(message.payload)).not.toContain('FULL CODEX PROVIDER CONTEXT');
  });
});
