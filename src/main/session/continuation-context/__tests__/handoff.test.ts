import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTrustedContinuationInitialTurn } from '../initial-turn';
import type { PreparedContinuationContext, ResolvedSuccessorSpec } from '../types';
import { observedContextCapacity, unknownContextCapacity } from './capacity-fixtures';

const prepareContinuationCandidates = vi.hoisted(() => vi.fn());
vi.mock('../service', () => ({ prepareContinuationCandidates }));
vi.mock('../resolver', () => ({
  continuationFingerprint: () => 'settings-fingerprint',
  resolveContinuationGeneratorSnapshot: () => ({
    adapter: 'claude-code', model: 'generator', thinking: 'medium',
    contextCapacity: unknownContextCapacity(), configFingerprint: 'generator-fingerprint',
  }),
  resolveContinuationRawRetentionCeiling: () => 64_000,
}));

import { prepareHandOffContinuation } from '../handoff';

const target: ResolvedSuccessorSpec = {
  adapter: 'codex-cli', model: 'target', thinking: 'high', sandbox: 'read-only',
  permissionMode: null, networkAccessEnabled: false, additionalDirectories: [],
  contextCapacity: observedContextCapacity(128_000, {
    adapter: 'codex-cli', runtimeProvider: 'openai', model: 'target',
  }), runtimeFingerprint: 'target-fingerprint',
};

function prepared(): PreparedContinuationContext {
  return {
    version: 1, providerPrompt: 'provider prompt', persistedUserText: 'continue',
    source: { eventRevision: 9, rebuildAfterRevision: 0, maxEventId: 9 },
    checkpoint: { id: 4, throughRevision: 9, formatVersion: 1, refreshed: true },
    projection: { canonicalHash: 'hash', omittedFacts: 0 }, quality: 'full',
    metrics: {
      rawRetentionCeilingTokens: 64_000, targetPromptCapacityTokens: 104_000,
      checkpointProjectionBudgetTokens: 12_000, generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 10, checkpointTokens: 5, rawTailTokens: 3,
      includedUserMessages: 1, truncatedBoundaryMessages: 0, foldCalls: 1,
      repairCalls: 0, elapsedMs: 1, uncoveredRevisionRange: null,
    },
    warnings: [], preparationHash: 'f'.repeat(64), spoolId: 'spool',
  };
}

describe('prepareHandOffContinuation', () => {
  beforeEach(() => prepareContinuationCandidates.mockReset());

  it('uses the shared capture path with exact handoff limits and returns a trusted turn', async () => {
    prepareContinuationCandidates.mockResolvedValueOnce({
      primary: prepared(),
      lowerBudgetRetry: null,
    });
    const result = await prepareHandOffContinuation({
      sourceSessionId: 'source', continuationInstruction: 'continue', target,
    });

    expect(prepareContinuationCandidates).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'handoff', sourceSessionId: 'source', continuationInstruction: 'continue',
      source: { mode: 'capture' }, target,
      limits: {
        rawRetentionCeilingTokens: 64_000,
        deadlineMs: 300_000,
        maxFoldCalls: 4,
        maxRepairCalls: 1,
      },
    }));
    expect(isTrustedContinuationInitialTurn(result.turn)).toBe(true);
    expect(result.turn.providerPrompt).toBe('provider prompt');
    expect(result.turn.persistedUserText).toBe('continue');
    expect(result.lowerBudgetRetry).toBeNull();
  });

  it('brands the pre-rendered lower-budget candidate without another preparation call', async () => {
    const primary = prepared();
    const retry = {
      ...prepared(),
      providerPrompt: 'smaller provider prompt',
      preparationHash: 'e'.repeat(64),
      metrics: { ...primary.metrics, targetPromptCapacityTokens: 8_000 },
    };
    prepareContinuationCandidates.mockResolvedValueOnce({
      primary,
      lowerBudgetRetry: retry,
    });

    const result = await prepareHandOffContinuation({
      sourceSessionId: 'source', continuationInstruction: 'continue', target,
    });

    expect(prepareContinuationCandidates).toHaveBeenCalledOnce();
    expect(result.lowerBudgetRetry?.prepared).toBe(retry);
    expect(result.lowerBudgetRetry?.turn.providerPrompt).toBe('smaller provider prompt');
  });
});
