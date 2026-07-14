import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  type ContinuationCheckpoint,
  type ContinuationCheckpointSection,
  type ContinuationFact,
} from './checkpoint-schema';
import { isCoverageGapFact } from './checkpoint-fold-coverage-gap';
import { estimateContinuationJsonTokens } from './token-estimator';

export const SOFT_CANONICAL_CHECKPOINT_TOKENS = 20_000;
export const MAX_CANONICAL_CHECKPOINT_TOKENS = 24_000;

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
const ORDERED_SECTIONS: readonly ContinuationCheckpointSection[] = [
  ...SECTION_PRIORITY,
  ...CONTINUATION_CHECKPOINT_SECTIONS.filter((section) => !SECTION_PRIORITY.includes(section)),
];

export interface CanonicalCheckpointFitSuccess {
  ok: true;
  checkpoint: ContinuationCheckpoint;
  candidateTokens: number;
  checkpointTokens: number;
  requiredTokens: number;
  omittedFacts: number;
  mode: 'unchanged' | 'soft-pruned' | 'hard-pruned';
}

export interface CanonicalCheckpointFitFailure {
  ok: false;
  candidateTokens: number;
  requiredTokens: number | null;
  reason: 'missing-required-fact' | 'required-facts-exceed-hard-limit';
}

export type CanonicalCheckpointFitResult =
  | CanonicalCheckpointFitSuccess
  | CanonicalCheckpointFitFailure;

function emptyCheckpoint(): ContinuationCheckpoint {
  return Object.fromEntries([
    ['formatVersion', 1],
    ...CONTINUATION_CHECKPOINT_SECTIONS.map((section) => [section, []]),
  ]) as unknown as ContinuationCheckpoint;
}

function factKey(section: ContinuationCheckpointSection, factId: string): string {
  return `${section}\u0000${factId}`;
}

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

function compareFactPriority(left: ContinuationFact, right: ContinuationFact): number {
  return (
    statusRank(left.status) - statusRank(right.status) ||
    right.priority - left.priority ||
    newestEvidenceRevision(right) - newestEvidenceRevision(left)
  );
}

function compareFacts(left: ContinuationFact, right: ContinuationFact): number {
  return compareFactPriority(left, right) || left.id.localeCompare(right.id);
}

function totalFacts(checkpoint: ContinuationCheckpoint): number {
  return CONTINUATION_CHECKPOINT_SECTIONS.reduce(
    (total, section) => total + checkpoint[section].length,
    0,
  );
}

function checkpointTokens(checkpoint: ContinuationCheckpoint): number {
  return estimateContinuationJsonTokens(checkpoint, { structuralOverhead: 8 });
}

function requiredFactKeys(input: {
  candidate: ContinuationCheckpoint;
  previous: ContinuationCheckpoint | null;
}): Set<string> | null {
  const required = new Set<string>();
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    for (const fact of input.candidate[section]) {
      if (fact.status === 'active' || fact.status === 'blocked' || isCoverageGapFact(fact)) {
        required.add(factKey(section, fact.id));
      }
    }
  }
  if (!input.previous) return required;
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    const candidateIds = new Set(input.candidate[section].map((fact) => fact.id));
    for (const fact of input.previous[section]) {
      if (fact.status !== 'active' && fact.status !== 'blocked') continue;
      if (!candidateIds.has(fact.id)) return null;
      required.add(factKey(section, fact.id));
    }
  }
  return required;
}

interface ProjectionState {
  requiredCheckpoint: ContinuationCheckpoint;
  optional: Array<{ section: ContinuationCheckpointSection; fact: ContinuationFact }>;
  requiredTokens: number;
  totalFacts: number;
}

function compareOptionalFacts(
  left: { section: ContinuationCheckpointSection; fact: ContinuationFact },
  right: { section: ContinuationCheckpointSection; fact: ContinuationFact },
): number {
  return (
    compareFactPriority(left.fact, right.fact) ||
    ORDERED_SECTIONS.indexOf(left.section) - ORDERED_SECTIONS.indexOf(right.section) ||
    left.fact.id.localeCompare(right.fact.id)
  );
}

function buildProjectionState(input: {
  candidate: ContinuationCheckpoint;
  requiredKeys: Set<string>;
}): ProjectionState {
  const requiredCheckpoint = emptyCheckpoint();
  const optional: Array<{ section: ContinuationCheckpointSection; fact: ContinuationFact }> = [];
  for (const section of ORDERED_SECTIONS) {
    for (const fact of [...input.candidate[section]].sort(compareFacts)) {
      if (input.requiredKeys.has(factKey(section, fact.id))) {
        requiredCheckpoint[section] = [...requiredCheckpoint[section], fact];
      } else {
        optional.push({ section, fact });
      }
    }
  }
  return {
    requiredCheckpoint,
    optional: optional.sort(compareOptionalFacts),
    requiredTokens: checkpointTokens(requiredCheckpoint),
    totalFacts: totalFacts(input.candidate),
  };
}

function projectToBudget(input: {
  candidateTokens: number;
  requiredKeys: Set<string>;
  state: ProjectionState;
  tokenBudget: number;
}): CanonicalCheckpointFitSuccess | null {
  if (input.state.requiredTokens > input.tokenBudget) return null;
  let projected = input.state.requiredCheckpoint;
  let selectedFacts = input.requiredKeys.size;
  for (const { section, fact } of input.state.optional) {
    const candidate: ContinuationCheckpoint = {
      ...projected,
      [section]: [...projected[section], fact],
    };
    if (checkpointTokens(candidate) <= input.tokenBudget) {
      projected = candidate;
      selectedFacts += 1;
    }
  }
  return {
    ok: true,
    checkpoint: projected,
    candidateTokens: input.candidateTokens,
    checkpointTokens: checkpointTokens(projected),
    requiredTokens: input.state.requiredTokens,
    omittedFacts: input.state.totalFacts - selectedFacts,
    mode:
      input.tokenBudget === SOFT_CANONICAL_CHECKPOINT_TOKENS
        ? 'soft-pruned'
        : 'hard-pruned',
  };
}

/**
 * Bound one persistence candidate without rewriting facts. Current active/blocked facts, app-owned
 * coverage markers, and facts that were active/blocked in the previous generation are all required.
 * The latter rule preserves a just-resolved/superseded fact for the generation that processed its
 * resolving evidence. Optional facts are retained whole in deterministic priority order.
 */
export function fitCanonicalCheckpointForPersistence(input: {
  candidate: ContinuationCheckpoint;
  previous: ContinuationCheckpoint | null;
}): CanonicalCheckpointFitResult {
  const candidateTokens = checkpointTokens(input.candidate);
  const requiredKeys = requiredFactKeys(input);
  if (!requiredKeys) {
    return {
      ok: false,
      candidateTokens,
      requiredTokens: null,
      reason: 'missing-required-fact',
    };
  }

  const state = buildProjectionState({ candidate: input.candidate, requiredKeys });
  if (candidateTokens <= SOFT_CANONICAL_CHECKPOINT_TOKENS) {
    return {
      ok: true,
      checkpoint: input.candidate,
      candidateTokens,
      checkpointTokens: candidateTokens,
      requiredTokens: state.requiredTokens,
      omittedFacts: 0,
      mode: 'unchanged',
    };
  }

  const softFit = projectToBudget({
    candidateTokens,
    requiredKeys,
    state,
    tokenBudget: SOFT_CANONICAL_CHECKPOINT_TOKENS,
  });
  if (softFit) return softFit;
  if (candidateTokens <= MAX_CANONICAL_CHECKPOINT_TOKENS) {
    return {
      ok: true,
      checkpoint: input.candidate,
      candidateTokens,
      checkpointTokens: candidateTokens,
      requiredTokens: state.requiredTokens,
      omittedFacts: 0,
      mode: 'unchanged',
    };
  }

  const hardFit = projectToBudget({
    candidateTokens,
    requiredKeys,
    state,
    tokenBudget: MAX_CANONICAL_CHECKPOINT_TOKENS,
  });
  if (hardFit) return hardFit;
  return {
    ok: false,
    candidateTokens,
    requiredTokens: state.requiredTokens,
    reason: 'required-facts-exceed-hard-limit',
  };
}
