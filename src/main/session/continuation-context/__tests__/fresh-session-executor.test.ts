import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSession = vi.fn(async (_target: unknown) => 'ordinary-session');
const createTrustedContinuationSession = vi.fn(
  async (_target: unknown, _turn: unknown) => 'trusted-session',
);
vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: vi.fn(() => ({ createSession, createTrustedContinuationSession })),
  },
}));

import type { CreateSessionOptions } from '@main/adapters/types';
import { executeFreshSession } from '../fresh-session-executor';
import { createOrdinaryInitialTurn, createTrustedContinuationInitialTurn } from '../initial-turn';
import type { PreparedContinuationContext } from '../types';

const target: CreateSessionOptions = {
  agentId: 'codex-cli',
  cwd: '/repo',
  prompt: 'public prompt',
  codexSandbox: 'read-only',
};

const prepared: PreparedContinuationContext = {
  version: 1, providerPrompt: 'full context', persistedUserText: 'next',
  source: { eventRevision: 1, rebuildAfterRevision: 0, maxEventId: 1 },
  checkpoint: { id: null, throughRevision: 0, formatVersion: 1, refreshed: false },
  projection: { canonicalHash: null, omittedFacts: 0 }, quality: 'raw-only',
  metrics: {
    rawRetentionCeilingTokens: 8_000, targetPromptCapacityTokens: 100_000,
    checkpointProjectionBudgetTokens: 2_000, generatorFoldInputBudgetTokens: 32_000,
    estimatedPromptTokens: 10, checkpointTokens: 0, rawTailTokens: 1, includedUserMessages: 1,
    truncatedBoundaryMessages: 0, foldCalls: 0, repairCalls: 0, elapsedMs: 1,
    uncoveredRevisionRange: null,
  },
  warnings: [], preparationHash: 'a'.repeat(64), spoolId: 'spool',
};

describe('fresh-session executor', () => {
  beforeEach(() => {
    createSession.mockClear();
    createTrustedContinuationSession.mockClear();
  });

  it('routes ordinary spawn through only the public create method and strips spoof fields', async () => {
    const spoofed = { ...target, trustedContinuation: { kind: 'trusted-continuation' } } as CreateSessionOptions;
    await expect(executeFreshSession(spoofed, createOrdinaryInitialTurn('ordinary'))).resolves.toBe('ordinary-session');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'ordinary' }));
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('trustedContinuation');
    expect(createTrustedContinuationSession).not.toHaveBeenCalled();
  });

  it('routes only a branded trusted turn to the private adapter method without a public prompt', async () => {
    const turn = createTrustedContinuationInitialTurn(prepared, 'source');
    await expect(executeFreshSession(target, turn)).resolves.toBe('trusted-session');
    expect(createTrustedContinuationSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ prompt: expect.anything() }),
      turn,
    );
    expect(createSession).not.toHaveBeenCalled();
    await expect(
      executeFreshSession(target, { kind: 'trusted-continuation' } as never),
    ).rejects.toThrow(/Unbranded/);
  });

  it('rejects resume because trusted and ordinary continuation starts are always fresh', async () => {
    await expect(
      executeFreshSession({ ...target, resume: 'old' }, createOrdinaryInitialTurn('x')),
    ).rejects.toThrow(/does not accept resume/);
  });
});
