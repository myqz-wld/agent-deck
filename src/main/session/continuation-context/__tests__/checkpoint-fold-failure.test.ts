import { describe, expect, it } from 'vitest';
import {
  classifyCheckpointFailureReason,
  recordCheckpointFoldFailure,
} from '../checkpoint-fold-failure';
import { CheckpointGeneratorError } from '../checkpoint-generator';
import type { ContinuationWarning } from '../types';

describe('checkpoint fold failure diagnostics', () => {
  it.each([
    [new CheckpointGeneratorError('provider timed out', 'timeout', 1), 'timeout'],
    [new SyntaxError('Unexpected token'), 'invalid-json'],
    [new Error('Checkpoint fact x cites evidence outside the exact fold allowlist'),
      'evidence-outside-allowlist'],
    [new Error('Active goals fact goal.active was removed'), 'active-fact-removed'],
    [new Error('Active risks fact risk.active changed without current-delta evidence'),
      'active-fact-changed-without-evidence'],
    [new Error('Coverage-gap marker marker.1 was rewritten'), 'coverage-marker-invariant'],
  ])('classifies %s without persisting raw provider output', (error, expected) => {
    expect(classifyCheckpointFailureReason(error)).toBe(expected);
  });

  it('records one bounded structured failure for the owning caller', () => {
    const warnings: ContinuationWarning[] = [];
    const diagnostic = recordCheckpointFoldFailure({
      warnings,
      code: 'checkpoint-repair-failed',
      stage: 'repair',
      error: new Error('Active goals fact private-id was removed'),
      providerCalls: 2,
      checkpointRevision: 10,
      captureRevision: 20,
      deadlineRemainingMs: 30,
    });

    expect(diagnostic).toEqual({
      stage: 'repair',
      category: 'checkpoint-validation',
      reason: 'active-fact-removed',
      providerCalls: 2,
      checkpointRevision: 10,
      captureRevision: 20,
      deadlineRemainingMs: 30,
    });
    expect(warnings[0].message).not.toContain('private-id');
  });
});
