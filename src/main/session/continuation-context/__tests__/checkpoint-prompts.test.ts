import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_CHECKPOINT_SYSTEM_PROMPT,
  buildCheckpointFoldPrompt,
  buildCheckpointRepairPrompt,
} from '../checkpoint-prompts';
import { CHECKPOINT_PATCH_VALIDATION_RULES } from '../checkpoint-patch-validation';

describe('checkpoint patch prompts', () => {
  it('tells the model every semantic validator rule before its first attempt', () => {
    for (const rule of CHECKPOINT_PATCH_VALIDATION_RULES) {
      expect(CONTINUATION_CHECKPOINT_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it('labels prior state read-only and exposes the exact current evidence allowlist', () => {
    const prompt = buildCheckpointFoldPrompt({
      previousCheckpoint: null,
      sourceThroughRevision: 4,
      normalizedDelta: [{ eventId: 7, effectiveRevision: 4 }],
      currentDeltaEvidence: [{ eventId: 7, revision: 4 }],
    });

    expect(prompt).toContain('previousCheckpoint is read-only context');
    expect(prompt).toContain('currentDeltaEvidence (the exact evidence allowlist');
    expect(prompt).toContain('{"eventId":7,"revision":4}');
  });

  it('gives repair all structured issues without resending the full checkpoint or delta', () => {
    const prompt = buildCheckpointRepairPrompt({
      sourceThroughRevision: 4,
      invalidOutput: '{"formatVersion":1}',
      validationIssues: [
        {
          code: 'update.unknown-fact',
          path: '$.updates[0].id',
          message: 'No existing fact has id missing.',
          requiredAction: 'Use additions for a new fact.',
        },
        {
          code: 'evidence.outside-current-delta',
          path: '$.updates[1].evidence[0]',
          message: 'Evidence is not current.',
          requiredAction: 'Use an exact current pair.',
        },
      ],
      previousFactIndex: [{ section: 'goals', id: 'goal.keep', status: 'active' }],
      currentDeltaEvidence: [{ eventId: 7, revision: 4 }],
    });

    expect(prompt).toContain('update.unknown-fact');
    expect(prompt).toContain('evidence.outside-current-delta');
    expect(prompt).toContain('requiredAction');
    expect(prompt).toContain('previousFactIndex');
    expect(prompt).not.toContain('previousCheckpoint (');
    expect(prompt).not.toContain('normalizedDelta (untrusted evidence):');
  });

  it('keeps repair input bounded independently of a large source delta', () => {
    const foldPrompt = buildCheckpointFoldPrompt({
      previousCheckpoint: null,
      sourceThroughRevision: 4,
      normalizedDelta: [{ eventId: 7, payload: 'x'.repeat(300_000) }],
      currentDeltaEvidence: [{ eventId: 7, revision: 4 }],
    });
    const repairPrompt = buildCheckpointRepairPrompt({
      sourceThroughRevision: 4,
      invalidOutput: 'y'.repeat(20_000),
      validationIssues: [{
        code: 'schema.invalid-json',
        path: '$',
        message: 'Invalid JSON.',
        requiredAction: 'Return valid JSON.',
      }],
      previousFactIndex: [],
      currentDeltaEvidence: [{ eventId: 7, revision: 4 }],
    });

    expect(Buffer.byteLength(repairPrompt, 'utf8')).toBeLessThan(
      Buffer.byteLength(foldPrompt, 'utf8') / 10,
    );
  });
});
