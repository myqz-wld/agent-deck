import { describe, expect, it } from 'vitest';
import {
  classifyCheckpointFailureReason,
  recordCheckpointFoldFailure,
} from '../checkpoint-fold-failure';
import { CheckpointPatchValidationError } from '../checkpoint-patch-validation';
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
    [new CheckpointPatchValidationError([{
      code: 'evidence.outside-current-delta',
      path: '$.updates[0].evidence[0]',
      message: 'Evidence is not current.',
      requiredAction: 'Use current evidence.',
    }]), 'evidence-outside-current-delta'],
    [new CheckpointPatchValidationError([{
      code: 'update.unknown-fact',
      path: '$.updates[0].id',
      message: 'Unknown id.',
      requiredAction: 'Use an existing id.',
    }]), 'patch-target-invalid'],
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
