import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_PROMPT_MAX_UTF8_BYTES,
  ContinuationBudgetError,
  assertContinuationPromptByteLimit,
  resolveContinuationBudgets,
  resolveGeneratorFoldInputBudgetTokens,
  targetNeedsLowerBudgetRetry,
  validateRawRetentionCeiling,
} from '../budget-policy';
import {
  observedContextCapacity,
  staleContextCapacity,
  unknownContextCapacity,
} from './capacity-fixtures';

describe('continuation budget policy', () => {
  it('keeps all four budgets distinct', () => {
    const budgets = resolveContinuationBudgets({
      rawRetentionCeilingTokens: 64_000,
      targetCapacity: observedContextCapacity(128_000),
      generatorCapacity: unknownContextCapacity(),
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
      targetCapacity: observedContextCapacity(40_000),
      generatorCapacity: observedContextCapacity(200_000),
      continuationInstruction: 'next',
      fixedWrapperTokens: 500,
      systemProjectReserveTokens: 4_000,
      responseReserveTokens: 4_000,
    });
    expect(budgets.generatorFoldInputBudgetTokens).toBe(128_000);
    expect(budgets.initialRawTailBudgetTokens).toBe(8_000);
    expect(budgets.checkpointProjectionBudgetTokens).toBeGreaterThanOrEqual(2_000);
  });

  it('rejects invalid raw settings and an instruction that cannot fit', () => {
    expect(() => validateRawRetentionCeiling(7_999)).toThrow(ContinuationBudgetError);
    expect(() => validateRawRetentionCeiling(8_000.5)).toThrow(ContinuationBudgetError);
    expect(() =>
      resolveContinuationBudgets({
        rawRetentionCeilingTokens: 64_000,
        targetCapacity: observedContextCapacity(8_000),
        generatorCapacity: unknownContextCapacity(),
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

  it.each([
    ['unknown', unknownContextCapacity()],
    ['stale', staleContextCapacity()],
  ] as const)('uses deterministic 64k/32k policies for %s capacity', (_status, capacity) => {
    const primary = resolveContinuationBudgets({
      rawRetentionCeilingTokens: 64_000,
      targetCapacity: capacity,
      generatorCapacity: capacity,
      continuationInstruction: 'next',
      fixedWrapperTokens: 0,
    });
    const retry = resolveContinuationBudgets({
      rawRetentionCeilingTokens: 64_000,
      targetCapacity: capacity,
      generatorCapacity: capacity,
      targetVariant: 'lower-budget-retry',
      continuationInstruction: 'next',
      fixedWrapperTokens: 0,
    });
    expect(primary.targetPromptCapacityTokens).toBe(40_000);
    expect(retry.targetPromptCapacityTokens).toBe(8_000);
    expect(primary.generatorFoldInputBudgetTokens).toBe(32_000);
    expect(resolveGeneratorFoldInputBudgetTokens(capacity)).toBe(32_000);
    expect(targetNeedsLowerBudgetRetry(capacity)).toBe(true);
  });
});
