import { describe, expect, it } from 'vitest';
import type { SessionAdapterId } from '@shared/types/session';
import {
  CONTINUATION_PROMPT_MAX_UTF8_BYTES,
  ContinuationBudgetError,
  assertContinuationPromptByteLimit,
  resolveContinuationBudgets,
  resolveGeneratorFoldInputBudgetTokens,
  validateRawRetentionCeiling,
} from '../budget-policy';
import {
  ContextCapacityResolver,
  DEFAULT_UNSEEN_MODEL_CONTEXT_WINDOW_TOKENS,
} from '../context-capacity-resolver';

describe('continuation budget policy', () => {
  it('keeps all four budgets distinct', () => {
    const budgets = resolveContinuationBudgets({
      rawRetentionCeilingTokens: 64_000,
      targetContextWindowTokens: 128_000,
      generatorContextWindowTokens: null,
      continuationInstruction: 'Continue from the validated checkpoint.',
      fixedWrapperTokens: 1_000,
    });
    expect(budgets.rawRetentionCeilingTokens).toBe(64_000);
    expect(budgets.targetPromptCapacityTokens).toBe(104_000);
    expect(budgets.checkpointProjectionBudgetTokens).toBe(12_000);
    expect(budgets.generatorFoldInputBudgetTokens).toBe(32_000);
    expect(budgets.initialRawTailBudgetTokens).toBeLessThanOrEqual(64_000);
  });

  it('returns unused historical capacity to neither unrelated budget during resolution', () => {
    const budgets = resolveContinuationBudgets({
      rawRetentionCeilingTokens: 8_000,
      targetContextWindowTokens: 40_000,
      generatorContextWindowTokens: 200_000,
      continuationInstruction: 'next',
      fixedWrapperTokens: 500,
      systemProjectReserveTokens: 4_000,
      responseReserveTokens: 4_000,
    });
    expect(budgets.generatorFoldInputBudgetTokens).toBe(100_000);
    expect(budgets.initialRawTailBudgetTokens).toBe(8_000);
    expect(budgets.checkpointProjectionBudgetTokens).toBeGreaterThanOrEqual(2_000);
  });

  it('rejects invalid raw settings and an instruction that cannot fit', () => {
    expect(() => validateRawRetentionCeiling(7_999)).toThrow(ContinuationBudgetError);
    expect(() => validateRawRetentionCeiling(8_000.5)).toThrow(ContinuationBudgetError);
    expect(() =>
      resolveContinuationBudgets({
        rawRetentionCeilingTokens: 64_000,
        targetContextWindowTokens: 8_000,
        generatorContextWindowTokens: null,
        continuationInstruction: 'x'.repeat(10_000),
        fixedWrapperTokens: 10,
        systemProjectReserveTokens: 4_000,
        responseReserveTokens: 4_000,
      }),
    ).toThrow(/current instruction/);
  });

  it('enforces the independent 512 KiB UTF-8 safety cap', () => {
    expect(() => assertContinuationPromptByteLimit('a'.repeat(CONTINUATION_PROMPT_MAX_UTF8_BYTES)))
      .not.toThrow();
    expect(() =>
      assertContinuationPromptByteLimit('界'.repeat(CONTINUATION_PROMPT_MAX_UTF8_BYTES / 2)),
    ).toThrow(/UTF-8 bytes/);
  });

  it('uses a conservative per-model observed-window cache and fallback', () => {
    const resolver = new ContextCapacityResolver();
    const adapter: SessionAdapterId = 'codex-cli';
    expect(resolver.resolve(adapter, 'custom')).toEqual({
      contextWindowTokens: DEFAULT_UNSEEN_MODEL_CONTEXT_WINDOW_TOKENS,
      source: 'fallback',
    });
    resolver.observe(adapter, 'custom', 200_000);
    resolver.observe(adapter, 'custom', 180_000);
    resolver.observe(adapter, 'custom', Number.NaN);
    expect(resolver.resolve(adapter, 'custom')).toEqual({
      contextWindowTokens: 180_000,
      source: 'observed',
    });
    expect(resolveGeneratorFoldInputBudgetTokens(null)).toBe(32_000);
  });
});
