import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/agent-deck-mcp/mcp-session-token-map', () => ({
  allocate: vi.fn(() => 'token'),
}));

import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { validateCreateSessionOpts } from '../create-session/create-session-validate';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { PreparedContinuationContext } from '@main/session/continuation-context/types';

function prepared(prompt: string): PreparedContinuationContext {
  return {
    version: 1, providerPrompt: prompt, persistedUserText: 'next',
    source: { eventRevision: 1, rebuildAfterRevision: 0, maxEventId: 1 },
    checkpoint: { id: null, throughRevision: 0, formatVersion: 1, refreshed: false },
    projection: { canonicalHash: null, omittedFacts: 0 }, quality: 'raw-only',
    metrics: {
      rawRetentionCeilingTokens: 8_000, targetPromptCapacityTokens: 100_000,
      checkpointProjectionBudgetTokens: 2_000, generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 40_000, checkpointTokens: 0, rawTailTokens: 1,
      includedUserMessages: 1, truncatedBoundaryMessages: 0, foldCalls: 0, repairCalls: 0,
      elapsedMs: 1, uncoveredRevisionRange: null,
    },
    warnings: [], preparationHash: 'a'.repeat(64), spoolId: 'spool',
  };
}

describe('Codex initial prompt split validation', () => {
  it('keeps the ordinary cap but accepts the branded token-valid continuation prompt', () => {
    const longPrompt = 'x'.repeat(MAX_USER_MESSAGE_LENGTH + 20_000);
    expect(() => validateCreateSessionOpts({ cwd: '/repo', prompt: longPrompt })).toThrow(/超出/);
    const trusted = createTrustedContinuationInitialTurn(prepared(longPrompt), 'source');
    expect(() =>
      validateCreateSessionOpts({
        cwd: '/repo', prompt: trusted.providerPrompt, trustedContinuation: trusted,
      }),
    ).not.toThrow();
  });
});
