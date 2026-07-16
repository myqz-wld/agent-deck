import { describe, expect, it } from 'vitest';
import { applyContinuationCheckpointPatch } from '../checkpoint-patch-reducer';
import { CheckpointPatchValidationError } from '../checkpoint-patch-validation';
import {
  canonicalizeContinuationCheckpoint,
  type ContinuationCheckpoint,
} from '../checkpoint-schema';

const previous: ContinuationCheckpoint = {
  formatVersion: 1,
  goals: [
    {
      id: 'goal.keep',
      status: 'active',
      text: 'Keep the unchanged goal',
      rationale: 'User requested it',
      priority: 90,
      evidence: [{ eventId: 1, revision: 1 }],
    },
  ],
  userIntent: [],
  constraints: [
    {
      id: 'constraint.finish',
      status: 'active',
      text: 'Finish the migration',
      validation: 'All tests pass',
      priority: 100,
      evidence: [{ eventId: 2, revision: 1 }],
    },
  ],
  decisions: [],
  completedWork: [],
  currentState: [],
  nextSteps: [],
  openQuestions: [],
  risks: [],
  keyFiles: [],
  commands: [],
  unresolvedErrors: [],
};

describe('checkpoint patch reducer', () => {
  it('preserves every omitted fact exactly for an empty patch', () => {
    const result = applyContinuationCheckpointPatch({
      previousCheckpoint: previous,
      patch: { formatVersion: 1, additions: [], updates: [] },
      currentDeltaEvidence: [{ eventId: 3, revision: 2 }],
    });

    expect(result.checkpoint).toEqual(previous);
    expect(result.payloadJson).toBe(canonicalizeContinuationCheckpoint(previous).payloadJson);
  });

  it('applies only named mutations and merges prior evidence deterministically', () => {
    const result = applyContinuationCheckpointPatch({
      previousCheckpoint: previous,
      patch: {
        formatVersion: 1,
        additions: [
          {
            section: 'decisions',
            fact: {
              id: 'decision.patch-state',
              status: 'active',
              text: 'Use deterministic patch reduction',
              rationale: '',
              validation: '',
              priority: 80,
              evidence: [{ eventId: 3, revision: 2 }],
            },
          },
        ],
        updates: [
          {
            section: 'constraints',
            id: 'constraint.finish',
            status: 'resolved',
            text: 'Migration finished',
            rationale: '',
            validation: 'Focused tests passed',
            priority: null,
            evidence: [{ eventId: 3, revision: 2 }],
          },
        ],
      },
      currentDeltaEvidence: [{ eventId: 3, revision: 2 }],
    });

    expect(result.checkpoint.goals[0]).toEqual(previous.goals[0]);
    expect(result.checkpoint.constraints[0]).toEqual({
      id: 'constraint.finish',
      status: 'resolved',
      text: 'Migration finished',
      validation: 'Focused tests passed',
      priority: 100,
      evidence: [
        { eventId: 2, revision: 1 },
        { eventId: 3, revision: 2 },
      ],
    });
    expect(result.checkpoint.decisions[0]).toEqual({
      id: 'decision.patch-state',
      status: 'active',
      text: 'Use deterministic patch reduction',
      priority: 80,
      evidence: [{ eventId: 3, revision: 2 }],
    });
  });

  it('returns all semantic violations with exact repair actions in one pass', () => {
    let error: unknown;
    try {
      applyContinuationCheckpointPatch({
        previousCheckpoint: previous,
        patch: {
          formatVersion: 1,
          additions: [
            {
              section: 'goals',
              fact: {
                id: 'constraint.finish',
                status: 'active',
                text: 'Duplicate',
                rationale: '',
                validation: '',
                priority: 1,
                evidence: [{ eventId: 999, revision: 999 }],
              },
            },
          ],
          updates: [
            {
              section: 'goals',
              id: 'goal.keep',
              status: null,
              text: 'Keep the unchanged goal',
              rationale: null,
              validation: null,
              priority: null,
              evidence: [{ eventId: 3, revision: 2 }],
            },
            {
              section: 'risks',
              id: 'risk.unknown',
              status: null,
              text: 'Unknown risk',
              rationale: null,
              validation: null,
              priority: null,
              evidence: [{ eventId: 3, revision: 2 }],
            },
          ],
        },
        currentDeltaEvidence: [{ eventId: 3, revision: 2 }],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CheckpointPatchValidationError);
    const issues = (error as CheckpointPatchValidationError).issues;
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'update.no-semantic-change',
        'update.unknown-fact',
        'evidence.outside-current-delta',
        'addition.existing-fact',
      ]),
    );
    expect(issues.every((issue) => issue.path.startsWith('$'))).toBe(true);
    expect(issues.every((issue) => issue.requiredAction.length > 0)).toBe(true);
  });
});
