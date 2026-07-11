import { describe, expect, it, vi } from 'vitest';
import { isTrustedContinuationInitialTurn } from '../initial-turn';
import type { PreparedContinuationContext, ResolvedSuccessorSpec } from '../types';

const prepareContinuationContext = vi.hoisted(() => vi.fn());
vi.mock('../service', () => ({ prepareContinuationContext }));
vi.mock('../resolver', () => ({
  continuationFingerprint: () => 'settings-fingerprint',
  resolveContinuationGeneratorSnapshot: () => ({
    adapter: 'claude-code', model: 'generator', thinking: 'medium',
    contextWindowTokens: null, configFingerprint: 'generator-fingerprint',
  }),
  resolveContinuationRawRetentionCeiling: () => 64_000,
}));

import { prepareHandOffContinuation } from '../handoff';

const target: ResolvedSuccessorSpec = {
  adapter: 'codex-cli', model: 'target', thinking: 'high', sandbox: 'read-only',
  permissionMode: null, networkAccessEnabled: false, additionalDirectories: [],
  contextWindowTokens: 128_000, runtimeFingerprint: 'target-fingerprint',
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
  it('uses the shared capture path with exact handoff limits and returns a trusted turn', async () => {
    prepareContinuationContext.mockResolvedValueOnce(prepared());
    const result = await prepareHandOffContinuation({
      sourceSessionId: 'source', continuationInstruction: 'continue', target,
    });

    expect(prepareContinuationContext).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'handoff', sourceSessionId: 'source', continuationInstruction: 'continue',
      source: { mode: 'capture' }, target,
      limits: {
        rawRetentionCeilingTokens: 64_000,
        deadlineMs: 120_000,
        maxFoldCalls: 4,
        maxRepairCalls: 1,
      },
    }));
    expect(isTrustedContinuationInitialTurn(result.turn)).toBe(true);
    expect(result.turn.providerPrompt).toBe('provider prompt');
    expect(result.turn.persistedUserText).toBe('continue');
  });
});
