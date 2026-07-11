import { describe, expect, it } from 'vitest';
import type { ContinuationCheckpointRecord } from '@main/store/continuation-checkpoint-repo';
import {
  canonicalizeContinuationCheckpoint,
  type ContinuationCheckpoint,
  type ContinuationFact,
} from '../checkpoint-schema';
import { isCoverageGapFact } from '../checkpoint-fold-coverage-gap';
import {
  assertActiveCheckpointFactsCarryForward,
  projectContinuationCheckpoint,
  projectContinuationCheckpointForFold,
} from '../checkpoint-projection';
import { estimateContinuationJsonTokens } from '../token-estimator';

function record(checkpoint: ContinuationCheckpoint): ContinuationCheckpointRecord {
  const canonical = canonicalizeContinuationCheckpoint(checkpoint);
  return {
    id: 1,
    sessionId: 'source',
    generation: 1,
    parentCheckpointId: null,
    formatVersion: 1,
    sourceEventRevision: 9,
    sourceRebuildAfterRevision: 0,
    sourceMaxEventId: 9,
    checkpoint: canonical.checkpoint,
    payloadJson: canonical.payloadJson,
    contentHash: canonical.contentHash,
    generatorAdapter: 'claude-code',
    generatorModel: null,
    generatorThinking: 'low',
    trigger: 'test',
    inputTokens: null,
    outputTokens: null,
    checkpointTokens: null,
    createdAt: 1,
  };
}

const base: ContinuationCheckpoint = {
  formatVersion: 1,
  goals: [],
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

const coverageMarker: ContinuationFact = {
  id: 'continuation.coverage-gap.after1.r2.0123456789abcdef',
  status: 'blocked',
  text: `Full semantic coverage stops after revision 1; revision 2 is represented only by bounded digest sha256:${'a'.repeat(64)}.`,
  rationale: 'The complete revision group did not fit the generator fold budget.',
  validation: 'Consult persisted source events before relying on omitted state.',
  priority: 100,
  evidence: [{ eventId: 2, revision: 2 }],
};

describe('canonical checkpoint projection', () => {
  it('selects whole facts deterministically by section/status/priority and preserves the hash', () => {
    const checkpoint: ContinuationCheckpoint = {
      ...base,
      constraints: [
        { id: 'constraint.active', status: 'active', text: 'Never reset.', priority: 100, evidence: [{ eventId: 1, revision: 1 }] },
      ],
      completedWork: [
        { id: 'completed.old', status: 'completed', text: 'Old detail '.repeat(80), priority: 1, evidence: [{ eventId: 2, revision: 2 }] },
      ],
      currentState: [
        { id: 'state.now', status: 'active', text: 'P4 is active.', priority: 90, evidence: [{ eventId: 9, revision: 9 }] },
      ],
    };
    const source = record(checkpoint);
    const first = projectContinuationCheckpoint(source, 180);
    const second = projectContinuationCheckpoint(source, 180);
    expect(second).toEqual(first);
    expect(first.canonicalHash).toBe(source.contentHash);
    expect(first.facts.constraints?.map((fact) => fact.id)).toEqual(['constraint.active']);
    expect(first.facts.completedWork).toBeUndefined();
    expect(first.omittedFacts).toBeGreaterThan(0);
    expect(source.checkpoint.completedWork[0].text).toContain('Old detail');
  });

  it('keeps active facts from every section in fold-only projections', () => {
    const checkpoint: ContinuationCheckpoint = {
      ...base,
      goals: [
        { id: 'goal.active', status: 'active', text: 'Ship it.', priority: 100, evidence: [{ eventId: 1, revision: 1 }] },
      ],
      currentState: [
        { id: 'state.blocked', status: 'blocked', text: 'Await validation.', priority: 90, evidence: [{ eventId: 2, revision: 2 }] },
      ],
      nextSteps: [
        { id: 'next.active', status: 'active', text: 'Run tests.', priority: 80, evidence: [{ eventId: 3, revision: 3 }] },
      ],
      completedWork: [
        { id: 'completed.old', status: 'completed', text: 'Old detail '.repeat(90), priority: 1, evidence: [{ eventId: 4, revision: 4 }] },
      ],
    };
    const requiredOnly: ContinuationCheckpoint = { ...checkpoint, completedWork: [] };
    const foldProjection = projectContinuationCheckpointForFold(
      checkpoint,
      estimateContinuationJsonTokens(requiredOnly, { structuralOverhead: 8 }),
    );

    expect(foldProjection.preservesActiveFacts).toBe(true);
    expect(foldProjection.omittedFacts).toBe(1);
    expect(foldProjection.checkpoint.goals[0]?.id).toBe('goal.active');
    expect(foldProjection.checkpoint.currentState[0]?.id).toBe('state.blocked');
    expect(foldProjection.checkpoint.nextSteps[0]?.id).toBe('next.active');
    expect(foldProjection.checkpoint.completedWork).toEqual([]);
    expect(() =>
      assertActiveCheckpointFactsCarryForward({
        previous: checkpoint,
        next: foldProjection.checkpoint,
        currentDeltaEvidence: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertActiveCheckpointFactsCarryForward({
        previous: checkpoint,
        next: { ...foldProjection.checkpoint, goals: [] },
        currentDeltaEvidence: [],
      }),
    ).toThrow(/Active goals fact goal\.active was removed/);
  });

  it('projects durable coverage markers before ordinary facts and keeps them immutable', () => {
    const checkpoint: ContinuationCheckpoint = {
      ...base,
      constraints: [
        {
          id: 'constraint.large',
          status: 'active',
          text: 'constraint '.repeat(80),
          priority: 100,
          evidence: [{ eventId: 1, revision: 1 }],
        },
      ],
      unresolvedErrors: [coverageMarker],
    };
    const projection = projectContinuationCheckpoint(record(checkpoint), 260);
    expect(projection.facts.unresolvedErrors).toEqual([coverageMarker]);
    expect(projection.facts.constraints).toBeUndefined();
    expect(projection.facts.unresolvedErrors?.every(isCoverageGapFact)).toBe(true);

    expect(() =>
      assertActiveCheckpointFactsCarryForward({
        previous: checkpoint,
        next: checkpoint,
        currentDeltaEvidence: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertActiveCheckpointFactsCarryForward({
        previous: checkpoint,
        next: { ...checkpoint, unresolvedErrors: [] },
        currentDeltaEvidence: [],
      }),
    ).toThrow(/coverage-gap marker .* was removed/i);
    expect(() =>
      assertActiveCheckpointFactsCarryForward({
        previous: checkpoint,
        next: {
          ...checkpoint,
          unresolvedErrors: [{ ...coverageMarker, text: 'rewritten marker' }],
        },
        currentDeltaEvidence: [{ eventId: 3, revision: 3 }],
      }),
    ).toThrow(/coverage-gap marker .* was rewritten/i);
    expect(() =>
      assertActiveCheckpointFactsCarryForward({
        previous: base,
        next: { ...base, unresolvedErrors: [coverageMarker] },
        currentDeltaEvidence: [{ eventId: 2, revision: 2 }],
      }),
    ).toThrow(/introduced reserved coverage-gap marker/i);
  });
});
