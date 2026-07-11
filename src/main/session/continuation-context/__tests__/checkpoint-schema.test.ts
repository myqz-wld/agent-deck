import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_CHECKPOINT_JSON_SCHEMA,
  canonicalizeContinuationCheckpoint,
  continuationCheckpointSchema,
  type ContinuationCheckpoint,
} from '../checkpoint-schema';

function baseCheckpoint(): ContinuationCheckpoint {
  return {
    formatVersion: 1,
    goals: [
      {
        id: 'goal.primary',
        status: 'active',
        text: 'Ship the continuation engine',
        priority: 100,
        evidence: [{ eventId: 1, revision: 1 }],
      },
    ],
    userIntent: [],
    constraints: [],
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
}

describe('continuation checkpoint schema', () => {
  it('normalizes and hashes semantically identical objects deterministically', () => {
    const first = canonicalizeContinuationCheckpoint(baseCheckpoint());
    const reordered = {
      unresolvedErrors: [],
      commands: [],
      keyFiles: [],
      risks: [],
      openQuestions: [],
      nextSteps: [],
      currentState: [],
      completedWork: [],
      decisions: [],
      constraints: [],
      userIntent: [],
      goals: [
        {
          evidence: [{ revision: 1, eventId: 1 }],
          priority: 100,
          text: '  Ship the continuation engine  ',
          status: 'active',
          id: 'goal.primary',
        },
      ],
      formatVersion: 1,
    };
    const second = canonicalizeContinuationCheckpoint(reordered);
    expect(second.payloadJson).toBe(first.payloadJson);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('rejects duplicate stable fact ids across sections', () => {
    const value = baseCheckpoint();
    value.risks.push({ ...value.goals[0], text: 'duplicate' });
    expect(continuationCheckpointSchema.safeParse(value).success).toBe(false);
  });

  it('exports a closed, required-section provider JSON schema', () => {
    expect(CONTINUATION_CHECKPOINT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['formatVersion', 'goals', 'unresolvedErrors']),
      properties: expect.objectContaining({
        formatVersion: { type: 'integer', const: 1 },
        goals: expect.objectContaining({ type: 'array' }),
      }),
    });
  });
});
