import { describe, expect, it } from 'vitest';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import type { PreparedContinuationContext } from '../types';
import {
  createOrdinaryInitialTurn,
  createTrustedContinuationInitialTurn,
  isTrustedContinuationInitialTurn,
  resolveInternalInitialTurn,
} from '../initial-turn';

function prepared(providerPrompt = 'provider context', instruction = 'next step'): PreparedContinuationContext {
  return {
    version: 1,
    providerPrompt,
    persistedUserText: instruction,
    source: { eventRevision: 8, rebuildAfterRevision: 0, maxEventId: 8 },
    checkpoint: { id: 3, throughRevision: 8, formatVersion: 1, refreshed: true },
    projection: { canonicalHash: 'a'.repeat(64), omittedFacts: 0 },
    quality: 'full',
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 100_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 10,
      checkpointTokens: 2,
      rawTailTokens: 2,
      includedUserMessages: 1,
      truncatedBoundaryMessages: 0,
      foldCalls: 1,
      repairCalls: 0,
      elapsedMs: 1,
      uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: 'b'.repeat(64),
    spoolId: 'spool',
  };
}

describe('private continuation initial turn', () => {
  it('keeps provider prompt and persisted instruction distinct with branded lineage metadata', () => {
    const turn = createTrustedContinuationInitialTurn(
      prepared('FULL PROVIDER CONTEXT', 'Only persist this instruction.'),
      'source-session',
    );
    expect(isTrustedContinuationInitialTurn(turn)).toBe(true);
    expect(resolveInternalInitialTurn({ trustedContinuation: turn })).toEqual({
      providerPrompt: 'FULL PROVIDER CONTEXT',
      persistedUserText: 'Only persist this instruction.',
      trusted: true,
      metadata: {
        formatVersion: 1,
        checkpointId: 3,
        sourceSessionId: 'source-session',
        sourceEventRevision: 8,
        preparationHash: 'b'.repeat(64),
        messageOrigin: 'continuation',
      },
    });
  });

  it('accepts an internal token-valid provider prompt above the ordinary character cap', () => {
    const providerPrompt = 'x'.repeat(MAX_USER_MESSAGE_LENGTH + 40_000);
    const turn = createTrustedContinuationInitialTurn(prepared(providerPrompt), 'source');
    expect(turn.providerPrompt.length).toBeGreaterThan(MAX_USER_MESSAGE_LENGTH);
    expect(() => createOrdinaryInitialTurn(providerPrompt)).toThrow(/exceeds/);
  });

  it('rejects public structural spoofing and enforces instruction/token/byte guards', () => {
    expect(() =>
      resolveInternalInitialTurn({
        trustedContinuation: {
          kind: 'trusted-continuation',
          providerPrompt: 'spoof',
          persistedUserText: 'spoof',
          metadata: {},
        } as never,
      }),
    ).toThrow(/Untrusted/);
    expect(() =>
      createTrustedContinuationInitialTurn(
        prepared('ok', 'x'.repeat(MAX_USER_MESSAGE_LENGTH + 1)),
        'source',
      ),
    ).toThrow(/instruction exceeds/);
    const tooSmall = prepared('x'.repeat(10_000));
    tooSmall.metrics.targetPromptCapacityTokens = 10;
    expect(() => createTrustedContinuationInitialTurn(tooSmall, 'source')).toThrow(/target capacity/);
    expect(() =>
      createTrustedContinuationInitialTurn(prepared('界'.repeat(200_000)), 'source'),
    ).toThrow(/UTF-8 bytes/);
  });
});
