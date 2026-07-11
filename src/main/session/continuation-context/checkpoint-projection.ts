import type { ContinuationCheckpointRecord } from '@main/store/continuation-checkpoint-repo';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  MAX_CHECKPOINT_FACTS_PER_SECTION,
  type ContinuationCheckpoint,
  type ContinuationCheckpointSection,
  type ContinuationFact,
} from './checkpoint-schema';
import type { CheckpointProjection } from './types';
import { estimateContinuationJsonTokens } from './token-estimator';
import {
  assertCoverageGapFactsImmutable,
  isCoverageGapFact,
} from './checkpoint-fold-coverage-gap';

const SECTION_PRIORITY: readonly ContinuationCheckpointSection[] = [
  'constraints',
  'currentState',
  'nextSteps',
  'unresolvedErrors',
  'goals',
  'userIntent',
  'decisions',
  'openQuestions',
  'risks',
  'keyFiles',
  'commands',
  'completedWork',
];

function statusRank(status: ContinuationFact['status']): number {
  switch (status) {
    case 'active':
    case 'blocked':
      return 0;
    case 'resolved':
    case 'superseded':
      return 1;
    case 'completed':
      return 2;
  }
}

function newestEvidenceRevision(fact: ContinuationFact): number {
  return Math.max(...fact.evidence.map((evidence) => evidence.revision));
}

function compareFacts(left: ContinuationFact, right: ContinuationFact): number {
  return (
    statusRank(left.status) - statusRank(right.status) ||
    right.priority - left.priority ||
    newestEvidenceRevision(right) - newestEvidenceRevision(left) ||
    left.id.localeCompare(right.id)
  );
}

function projectionTokens(projection: CheckpointProjection): number {
  return estimateContinuationJsonTokens(projection, { structuralOverhead: 8 });
}

function emptyCheckpoint(): ContinuationCheckpoint {
  return Object.fromEntries([
    ['formatVersion', 1],
    ...CONTINUATION_CHECKPOINT_SECTIONS.map((section) => [section, []]),
  ]) as unknown as ContinuationCheckpoint;
}

export interface FoldCheckpointProjection {
  checkpoint: ContinuationCheckpoint;
  omittedFacts: number;
  preservesActiveFacts: boolean;
}

function evidenceKey(evidence: { eventId: number; revision: number }): string {
  return `${evidence.eventId}:${evidence.revision}`;
}

/** Enforce the plan-level carry-forward invariant for active facts in every checkpoint section. */
export function assertActiveCheckpointFactsCarryForward(input: {
  previous: ContinuationCheckpoint | null;
  next: ContinuationCheckpoint;
  currentDeltaEvidence: Array<{ eventId: number; revision: number }>;
}): void {
  assertCoverageGapFactsImmutable({ previous: input.previous, next: input.next });
  if (!input.previous) return;
  const deltaEvidence = new Set(input.currentDeltaEvidence.map(evidenceKey));
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    const nextById = new Map(input.next[section].map((fact) => [fact.id, fact]));
    for (const prior of input.previous[section]) {
      if (prior.status !== 'active' && prior.status !== 'blocked') continue;
      const candidate = nextById.get(prior.id);
      if (!candidate) throw new Error(`Active ${section} fact ${prior.id} was removed`);
      const semanticChanged =
        candidate.text !== prior.text ||
        candidate.rationale !== prior.rationale ||
        candidate.validation !== prior.validation ||
        candidate.status !== prior.status;
      if (
        semanticChanged &&
        !candidate.evidence.some((evidence) => deltaEvidence.has(evidenceKey(evidence)))
      ) {
        throw new Error(`Active ${section} fact ${prior.id} changed without current-delta evidence`);
      }
    }
  }
}

/** Add one app-owned marker while retaining every active/blocked fact and only pruning whole inactive facts. */
export function projectContinuationCheckpointWithCoverageMarker(input: {
  previous: ContinuationCheckpoint | null;
  marker: ContinuationFact;
  tokenBudget: number;
}): FoldCheckpointProjection | null {
  if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0) {
    throw new Error('tokenBudget must be a non-negative safe integer');
  }
  const previous = input.previous ?? emptyCheckpoint();
  if (
    !isCoverageGapFact(input.marker) ||
    input.marker.status !== 'blocked' ||
    CONTINUATION_CHECKPOINT_SECTIONS.some((section) =>
      previous[section].some((fact) => fact.id === input.marker.id),
    )
  ) {
    return null;
  }
  const required = emptyCheckpoint();
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    required[section] = previous[section].filter(
      (fact) => fact.status === 'active' || fact.status === 'blocked',
    );
  }
  if (required.unresolvedErrors.length >= MAX_CHECKPOINT_FACTS_PER_SECTION) return null;
  required.unresolvedErrors = [...required.unresolvedErrors, input.marker];
  if (estimateContinuationJsonTokens(required, { structuralOverhead: 8 }) > input.tokenBudget) {
    return null;
  }

  let projected = required;
  const optional = SECTION_PRIORITY.flatMap((section) =>
    previous[section]
      .filter((fact) => fact.status !== 'active' && fact.status !== 'blocked')
      .sort(compareFacts)
      .map((fact) => ({ section, fact })),
  );
  let selectedOptional = 0;
  for (const { section, fact } of optional) {
    if (projected[section].length >= MAX_CHECKPOINT_FACTS_PER_SECTION) continue;
    const candidate: ContinuationCheckpoint = {
      ...projected,
      [section]: [...projected[section], fact],
    };
    if (estimateContinuationJsonTokens(candidate, { structuralOverhead: 8 }) <= input.tokenBudget) {
      projected = candidate;
      selectedOptional += 1;
    }
  }
  return {
    checkpoint: projected,
    omittedFacts: optional.length - selectedOptional,
    preservesActiveFacts: true,
  };
}

/**
 * Build a whole-fact prior-checkpoint view used only as generator input. Every active/blocked fact
 * leads the ordering so callers can refuse a lossy fold when that required set does not fit. The
 * returned view is never persisted as a checkpoint by itself.
 */
export function projectContinuationCheckpointForFold(
  checkpoint: ContinuationCheckpoint,
  tokenBudget: number,
): FoldCheckpointProjection {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new Error('tokenBudget must be a non-negative safe integer');
  }
  const requiredIds = new Set(
    CONTINUATION_CHECKPOINT_SECTIONS.flatMap((section) =>
      checkpoint[section]
        .filter((fact) => fact.status === 'active' || fact.status === 'blocked')
        .map((fact) => fact.id),
    ),
  );
  const activeFacts = SECTION_PRIORITY.flatMap((section) =>
    [...checkpoint[section]]
      .filter((fact) => requiredIds.has(fact.id))
      .sort(compareFacts)
      .map((fact) => ({ section, fact })),
  );
  const remainingFacts = SECTION_PRIORITY.flatMap((section) =>
    [...checkpoint[section]]
      .filter((fact) => !requiredIds.has(fact.id))
      .sort(compareFacts)
      .map((fact) => ({ section, fact })),
  );
  let projected = emptyCheckpoint();
  for (const { section, fact } of activeFacts) {
    projected[section] = [...projected[section], fact];
  }
  const activeFit =
    estimateContinuationJsonTokens(projected, { structuralOverhead: 8 }) <= tokenBudget;
  if (!activeFit) projected = emptyCheckpoint();
  const selectedIds = new Set(activeFit ? requiredIds : []);
  for (const { section, fact } of activeFit ? remainingFacts : []) {
    const candidate: ContinuationCheckpoint = {
      ...projected,
      [section]: [...projected[section], fact],
    };
    if (estimateContinuationJsonTokens(candidate, { structuralOverhead: 8 }) <= tokenBudget) {
      projected[section] = candidate[section];
      selectedIds.add(fact.id);
    }
  }
  const totalFacts = CONTINUATION_CHECKPOINT_SECTIONS.reduce(
    (total, section) => total + checkpoint[section].length,
    0,
  );
  return {
    checkpoint: projected,
    omittedFacts: totalFacts - selectedIds.size,
    preservesActiveFacts: activeFit,
  };
}

/** Select whole canonical facts deterministically without mutating or re-saving the checkpoint. */
export function projectContinuationCheckpoint(
  record: ContinuationCheckpointRecord,
  tokenBudget: number,
): CheckpointProjection {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new Error('tokenBudget must be a non-negative safe integer');
  }
  const totalFacts = CONTINUATION_CHECKPOINT_SECTIONS.reduce(
    (total, section) => total + record.checkpoint[section].length,
    0,
  );
  const projection: CheckpointProjection = {
    formatVersion: 1,
    canonicalHash: record.contentHash,
    sourceEventRevision: record.sourceEventRevision,
    facts: {},
    omittedFacts: totalFacts,
  };

  const orderedFacts = [
    ...record.checkpoint.unresolvedErrors
      .filter(isCoverageGapFact)
      .sort(compareFacts)
      .map((fact) => ({ section: 'unresolvedErrors' as const, fact })),
    ...SECTION_PRIORITY.flatMap((section) =>
      record.checkpoint[section]
        .filter((fact) => !isCoverageGapFact(fact))
        .sort(compareFacts)
        .map((fact) => ({ section, fact })),
    ),
  ];
  for (const { section, fact } of orderedFacts) {
    const current = projection.facts[section] ?? [];
    const candidate: CheckpointProjection = {
      ...projection,
      facts: { ...projection.facts, [section]: [...current, fact] },
      omittedFacts: projection.omittedFacts - 1,
    };
    if (projectionTokens(candidate) <= tokenBudget) {
      projection.facts = candidate.facts;
      projection.omittedFacts = candidate.omittedFacts;
    }
  }
  return projection;
}

export function estimateCheckpointProjectionTokens(projection: CheckpointProjection | null): number {
  return projection ? projectionTokens(projection) : 0;
}
