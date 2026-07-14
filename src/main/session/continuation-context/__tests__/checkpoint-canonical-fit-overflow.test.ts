import { describe, expect, it } from 'vitest';
import {
  fitCanonicalCheckpointForPersistence,
  MAX_CANONICAL_CHECKPOINT_TOKENS,
  SOFT_CANONICAL_CHECKPOINT_TOKENS,
} from '../checkpoint-canonical-fit';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import { estimateContinuationJsonTokens } from '../token-estimator';
import {
  checkpointAtExactTokens,
  coverageMarker,
  emptyCheckpoint,
  largeInactiveFacts,
  makeFact,
} from './checkpoint-overflow-fixtures';

describe('canonical checkpoint persistence fit', () => {
  it('keeps the exact 20k soft fencepost byte-for-byte', () => {
    const candidate = checkpointAtExactTokens(SOFT_CANONICAL_CHECKPOINT_TOKENS);

    const fit = fitCanonicalCheckpointForPersistence({ candidate, previous: null });

    expect(fit).toMatchObject({
      ok: true,
      mode: 'unchanged',
      checkpointTokens: SOFT_CANONICAL_CHECKPOINT_TOKENS,
      omittedFacts: 0,
    });
    if (!fit.ok) return;
    expect(fit.checkpoint).toBe(candidate);
  });

  it('fails closed when a previously active fact is missing from the candidate', () => {
    const previous: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: [makeFact({ id: 'goal.required', status: 'active', eventId: 1, revision: 1 })],
    };

    expect(
      fitCanonicalCheckpointForPersistence({ candidate: emptyCheckpoint(), previous }),
    ).toMatchObject({ ok: false, reason: 'missing-required-fact' });
  });

  it('prunes only whole inactive facts and retains resolved carry-forward plus coverage markers', () => {
    const previous: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: [makeFact({ id: 'goal.resolved-now', status: 'active', eventId: 1, revision: 1 })],
      unresolvedErrors: [coverageMarker],
    };
    const resolved = makeFact({
      id: 'goal.resolved-now',
      status: 'resolved',
      eventId: 2,
      revision: 2,
      text: 'The goal was resolved by the current delta.',
    });
    const active = makeFact({ id: 'state.active', status: 'active', eventId: 2, revision: 2 });
    const blocked = makeFact({ id: 'next.blocked', status: 'blocked', eventId: 2, revision: 2 });
    const candidate: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      goals: [resolved],
      completedWork: largeInactiveFacts(2, 2),
      currentState: [active],
      nextSteps: [blocked],
      unresolvedErrors: [coverageMarker],
    };
    expect(estimateContinuationJsonTokens(candidate, { structuralOverhead: 8 })).toBeGreaterThan(
      MAX_CANONICAL_CHECKPOINT_TOKENS,
    );

    const fit = fitCanonicalCheckpointForPersistence({ candidate, previous });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.mode).toBe('soft-pruned');
    expect(fit.checkpointTokens).toBeLessThanOrEqual(SOFT_CANONICAL_CHECKPOINT_TOKENS);
    expect(fit.omittedFacts).toBeGreaterThan(0);
    expect(fit.checkpoint.goals).toEqual([resolved]);
    expect(fit.checkpoint.currentState).toEqual([active]);
    expect(fit.checkpoint.nextSteps).toEqual([blocked]);
    expect(fit.checkpoint.unresolvedErrors).toEqual([coverageMarker]);
    expect(fit.checkpoint.completedWork.length).toBeLessThan(candidate.completedWork.length);
  });

  it('accepts the exact 24k fencepost and fails closed above it', () => {
    const atHardLimit = checkpointAtExactTokens(MAX_CANONICAL_CHECKPOINT_TOKENS);
    const fit = fitCanonicalCheckpointForPersistence({ candidate: atHardLimit, previous: null });
    expect(fit).toMatchObject({ ok: true, mode: 'unchanged', checkpointTokens: 24_000 });

    const overHardLimit: ContinuationCheckpoint = {
      ...atHardLimit,
      goals: [
        { ...atHardLimit.goals[0], rationale: 'This makes the required set exceed the hard limit.' },
        ...atHardLimit.goals.slice(1),
      ],
    };
    expect(
      estimateContinuationJsonTokens(overHardLimit, { structuralOverhead: 8 }),
    ).toBeGreaterThan(MAX_CANONICAL_CHECKPOINT_TOKENS);
    expect(
      fitCanonicalCheckpointForPersistence({ candidate: overHardLimit, previous: null }),
    ).toMatchObject({
      ok: false,
      reason: 'required-facts-exceed-hard-limit',
    });
  });

  it('uses the 24k fallback when the required set is above the soft target', () => {
    const required = checkpointAtExactTokens(22_000);
    const candidate: ContinuationCheckpoint = {
      ...required,
      completedWork: largeInactiveFacts(2, 2),
    };
    expect(estimateContinuationJsonTokens(candidate, { structuralOverhead: 8 })).toBeGreaterThan(
      MAX_CANONICAL_CHECKPOINT_TOKENS,
    );

    const fit = fitCanonicalCheckpointForPersistence({ candidate, previous: null });

    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.mode).toBe('hard-pruned');
    expect(fit.requiredTokens).toBe(22_000);
    expect(fit.checkpointTokens).toBeGreaterThan(SOFT_CANONICAL_CHECKPOINT_TOKENS);
    expect(fit.checkpointTokens).toBeLessThanOrEqual(MAX_CANONICAL_CHECKPOINT_TOKENS);
    expect(fit.checkpoint.goals.map((fact) => fact.id).sort()).toEqual(
      required.goals.map((fact) => fact.id).sort(),
    );
    expect(fit.checkpoint.currentState.map((fact) => fact.id).sort()).toEqual(
      required.currentState.map((fact) => fact.id).sort(),
    );
    expect(fit.omittedFacts).toBeGreaterThan(0);
  });

  it('ranks inactive facts globally by status before section priority', () => {
    const resolved = Array.from({ length: 16 }, (_, index) =>
      makeFact({
        id: `decision.resolved.${index}`,
        status: 'resolved',
        eventId: 2,
        revision: 2,
        text: `resolved-${index}-${'r'.repeat(800)}`,
        rationale: `resolved-rationale-${index}-${'r'.repeat(800)}`,
        priority: 100 - index,
      }),
    );
    const completed = Array.from({ length: 48 }, (_, index) =>
      makeFact({
        id: `constraint.completed.${index}`,
        status: 'completed',
        eventId: 1,
        revision: 1,
        text: `completed-${index}-${'c'.repeat(800)}`,
        rationale: `completed-rationale-${index}-${'c'.repeat(800)}`,
        priority: 100,
      }),
    );
    const candidate: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      constraints: completed,
      decisions: resolved,
    };
    expect(estimateContinuationJsonTokens(candidate, { structuralOverhead: 8 })).toBeGreaterThan(
      MAX_CANONICAL_CHECKPOINT_TOKENS,
    );

    const fit = fitCanonicalCheckpointForPersistence({ candidate, previous: null });

    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.checkpoint.decisions).toEqual(resolved);
    expect(fit.checkpoint.constraints.length).toBeLessThan(completed.length);
  });

  it('uses section priority before id for otherwise equal inactive facts', () => {
    const constraints = Array.from({ length: 20 }, (_, index) =>
      makeFact({
        id: `z.constraint.${index.toString().padStart(2, '0')}`,
        status: 'completed',
        eventId: 1,
        revision: 1,
        text: `constraint-${index}-${'c'.repeat(800)}`,
        rationale: `constraint-rationale-${index}-${'c'.repeat(800)}`,
      }),
    );
    const completedWork = Array.from({ length: 60 }, (_, index) =>
      makeFact({
        id: `a.completed.${index.toString().padStart(2, '0')}`,
        status: 'completed',
        eventId: 1,
        revision: 1,
        text: `completed-${index}-${'w'.repeat(800)}`,
        rationale: `completed-rationale-${index}-${'w'.repeat(800)}`,
      }),
    );
    const candidate: ContinuationCheckpoint = {
      ...emptyCheckpoint(),
      constraints,
      completedWork,
    };
    expect(estimateContinuationJsonTokens(candidate, { structuralOverhead: 8 })).toBeGreaterThan(
      MAX_CANONICAL_CHECKPOINT_TOKENS,
    );

    const fit = fitCanonicalCheckpointForPersistence({ candidate, previous: null });

    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.checkpoint.constraints).toEqual(constraints);
    expect(fit.checkpoint.completedWork.length).toBeLessThan(completedWork.length);
  });
});
