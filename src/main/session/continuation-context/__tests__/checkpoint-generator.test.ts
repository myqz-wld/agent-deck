import { describe, expect, it } from 'vitest';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import { validateGeneratedContinuationCheckpoint } from '../checkpoint-generator';

const empty: ContinuationCheckpoint = {
  formatVersion: 1,
  goals: [], userIntent: [], constraints: [], decisions: [], completedWork: [], currentState: [],
  nextSteps: [], openQuestions: [], risks: [], keyFiles: [], commands: [], unresolvedErrors: [],
};

describe('checkpoint generator validation', () => {
  it('rejects forged evidence pairs', () => {
    expect(() =>
      validateGeneratedContinuationCheckpoint({
        output: {
          ...empty,
          goals: [{ id: 'goal.forged', status: 'active', text: 'forged', priority: 1, evidence: [{ eventId: 999, revision: 999 }] }],
        },
        previousCheckpoint: null,
        allowedEvidence: [{ eventId: 1, revision: 1 }],
        currentDeltaEvidence: [{ eventId: 1, revision: 1 }],
      }),
    ).toThrow(/outside the exact fold allowlist/);
  });

  it('requires active protected facts to carry forward or use current evidence to resolve', () => {
    const previous: ContinuationCheckpoint = {
      ...empty,
      constraints: [{ id: 'constraint.keep', status: 'active', text: 'Keep me', priority: 100, evidence: [{ eventId: 1, revision: 1 }] }],
    };
    expect(() =>
      validateGeneratedContinuationCheckpoint({
        output: empty,
        previousCheckpoint: previous,
        allowedEvidence: [{ eventId: 1, revision: 1 }, { eventId: 2, revision: 2 }],
        currentDeltaEvidence: [{ eventId: 2, revision: 2 }],
      }),
    ).toThrow(/removed without explicit evidence/);

    expect(() =>
      validateGeneratedContinuationCheckpoint({
        output: {
          ...empty,
          constraints: [{ id: 'constraint.keep', status: 'active', text: 'Silently changed', priority: 100, evidence: [{ eventId: 1, revision: 1 }] }],
        },
        previousCheckpoint: previous,
        allowedEvidence: [{ eventId: 1, revision: 1 }, { eventId: 2, revision: 2 }],
        currentDeltaEvidence: [{ eventId: 2, revision: 2 }],
      }),
    ).toThrow(/changed without current-delta evidence/);

    const resolved = validateGeneratedContinuationCheckpoint({
      output: {
        ...empty,
        constraints: [{ id: 'constraint.keep', status: 'resolved', text: 'Resolved', priority: 100, evidence: [{ eventId: 2, revision: 2 }] }],
      },
      previousCheckpoint: previous,
      allowedEvidence: [{ eventId: 1, revision: 1 }, { eventId: 2, revision: 2 }],
      currentDeltaEvidence: [{ eventId: 2, revision: 2 }],
    });
    expect(resolved.checkpoint.constraints[0].status).toBe('resolved');
  });
});
