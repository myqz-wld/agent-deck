import { describe, expect, it } from 'vitest';
import { parseGeneratedContinuationCheckpointPatch } from '../checkpoint-generator';
import { CheckpointPatchValidationError } from '../checkpoint-patch-validation';

describe('checkpoint generator patch parsing', () => {
  it('accepts an empty patch from either structured output or JSON text', () => {
    const empty = { formatVersion: 1, additions: [], updates: [] };
    expect(parseGeneratedContinuationCheckpointPatch(empty)).toEqual(empty);
    expect(parseGeneratedContinuationCheckpointPatch(JSON.stringify(empty))).toEqual(empty);
  });

  it('reports every schema issue with a precise path and required action', () => {
    let error: unknown;
    try {
      parseGeneratedContinuationCheckpointPatch({
        formatVersion: 1,
        additions: [{ section: 'not-a-section', fact: { id: '', status: 'active' } }],
        updates: [{}],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CheckpointPatchValidationError);
    const issues = (error as CheckpointPatchValidationError).issues;
    expect(issues.length).toBeGreaterThan(3);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '$.additions[0].section' }),
        expect.objectContaining({ path: '$.additions[0].fact.id' }),
        expect.objectContaining({ path: '$.updates[0].id' }),
      ]),
    );
    expect(issues.every((issue) => issue.requiredAction.length > 0)).toBe(true);
  });

  it('returns an actionable invalid-JSON issue instead of a raw parser failure', () => {
    expect(() => parseGeneratedContinuationCheckpointPatch('{bad json')).toThrowError(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: 'schema.invalid-json',
            path: '$',
            requiredAction: expect.stringMatching(/valid CheckpointPatch JSON/),
          }),
        ],
      }),
    );
  });
});
