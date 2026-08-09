import { describe, expect, it } from 'vitest';
import { ContinuationBudgetError, type ResolvedContinuationBudgets } from '../budget-policy';
import type { FoldContinuationCheckpointResult } from '../checkpoint-fold';
import { renderPreparedContinuation } from '../preparation-renderer';
import type { ContinuationSpoolMetadata } from '../source-spool';
import type {
  PrepareContinuationContextInput,
  RawContinuationUserInput,
} from '../types';
import { observedContextCapacity } from './capacity-fixtures';

const metadata: ContinuationSpoolMetadata = {
  spoolId: 'spool',
  sessionId: 'source',
  createdAt: 1,
  expiresAt: 10_000,
  lastAccessedAt: 1,
  captureRevision: 1,
  rebuildAfterRevision: 0,
  maxEventId: 1,
  runtimeFingerprint: 'source-v1',
  checkpoint: null,
  checkpointThroughRevision: 0,
  materializedThroughRevision: 1,
  uncoveredRevisionRange: null,
  spoolBytes: 1,
  rawTailTokens: 0,
  rawWarnings: [],
  rawScanTruncated: false,
};

const fold: FoldContinuationCheckpointResult = {
  checkpoint: null,
  refreshed: false,
  foldCalls: 0,
  repairCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  observedContextWindowEvidence: null,
  warnings: [],
  failure: null,
  uncoveredRevisionRange: null,
};

function request(instruction: string): PrepareContinuationContextInput {
  return {
    purpose: 'handoff',
    sourceSessionId: 'source',
    continuationInstruction: instruction,
    generator: {
      adapter: 'claude-code',
      model: 'generator',
      thinking: 'low',
      contextCapacity: observedContextCapacity(200_000),
      configFingerprint: 'generator-v1',
    },
    target: {
      adapter: 'codex-cli',
      model: 'target',
      thinking: 'medium',
      sandbox: 'read-only',
      permissionMode: null,
      networkAccessEnabled: false,
      additionalDirectories: [],
      contextCapacity: observedContextCapacity(200_000),
      runtimeFingerprint: 'target-v1',
    },
    source: { mode: 'immutable-spool', spoolId: 'spool' },
    limits: {
      rawRetentionCeilingTokens: 128_000,
      deadlineMs: 1_000,
      maxFoldCalls: 0,
      maxRepairCalls: 0,
    },
  };
}

function raw(text: string): RawContinuationUserInput[] {
  return [{
    eventId: 1,
    effectiveRevision: 1,
    ts: 1,
    text,
    attachments: [],
    origin: 'user',
    truncated: false,
    omittedEstimatedTokens: 0,
  }];
}

function budgets(overrides: Partial<ResolvedContinuationBudgets>): ResolvedContinuationBudgets {
  return {
    rawRetentionCeilingTokens: 128_000,
    targetPromptCapacityTokens: 200_000,
    checkpointProjectionBudgetTokens: 0,
    generatorFoldInputBudgetTokens: 32_000,
    instructionTokens: 1,
    fixedWrapperTokens: 1,
    historicalCapacityTokens: 128_000,
    initialRawTailBudgetTokens: 128_000,
    ...overrides,
  };
}

describe('renderPreparedContinuation', () => {
  it('re-renders after reducing raw history to meet the token capacity', () => {
    const result = renderPreparedContinuation({
      request: request('Continue.'),
      metadata,
      fold,
      budgets: budgets({ targetPromptCapacityTokens: 500 }),
      capturedRaw: raw('x'.repeat(40_000)),
      baseWarnings: [],
      elapsedMs: 1,
    });

    expect(result.metrics.estimatedPromptTokens).toBeLessThanOrEqual(500);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'raw-boundary-truncated',
    }));
  });

  it('re-renders after reducing raw history to meet the UTF-8 byte limit', () => {
    const result = renderPreparedContinuation({
      request: request('i'.repeat(100_000)),
      metadata,
      fold,
      budgets: budgets({ targetPromptCapacityTokens: 200_000 }),
      capturedRaw: raw('x'.repeat(460_000)),
      baseWarnings: [],
      elapsedMs: 1,
    });

    expect(Buffer.byteLength(result.providerPrompt, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'raw-boundary-truncated',
    }));
  });

  it('preserves prompt-byte-limit when the instruction-only prompt is oversized', () => {
    expect(() => renderPreparedContinuation({
      request: request('界'.repeat(200_000)),
      metadata,
      fold,
      budgets: budgets({ targetPromptCapacityTokens: 300_000, historicalCapacityTokens: 0 }),
      capturedRaw: [],
      baseWarnings: [],
      elapsedMs: 1,
    })).toThrowError(expect.objectContaining<Partial<ContinuationBudgetError>>({
      code: 'prompt-byte-limit',
    }));
  });
});
