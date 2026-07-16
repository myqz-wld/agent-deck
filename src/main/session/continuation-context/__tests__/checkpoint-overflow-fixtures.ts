import { vi } from 'vitest';
import type {
  CheckpointGeneratorRequest,
  CheckpointGeneratorResult,
  ContinuationCheckpointGenerator,
} from '../checkpoint-generator';
import type { ContinuationCheckpointPatch } from '../checkpoint-patch-schema';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  type ContinuationCheckpoint,
  type ContinuationCheckpointSection,
  type ContinuationFact,
} from '../checkpoint-schema';
import { estimateContinuationJsonTokens } from '../token-estimator';

export function emptyCheckpoint(): ContinuationCheckpoint {
  return {
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
}

export function makeFact(input: {
  id: string;
  status: ContinuationFact['status'];
  eventId: number;
  revision: number;
  text?: string;
  priority?: number;
  rationale?: string;
}): ContinuationFact {
  return {
    id: input.id,
    status: input.status,
    text: input.text ?? input.id,
    ...(input.rationale ? { rationale: input.rationale } : {}),
    priority: input.priority ?? 50,
    evidence: [{ eventId: input.eventId, revision: input.revision }],
  };
}

export function largeInactiveFacts(eventId: number, revision: number): ContinuationFact[] {
  return Array.from({ length: 64 }, (_, index) =>
    makeFact({
      id: `completed.large.${index}`,
      status: index % 2 === 0 ? 'completed' : 'resolved',
      eventId,
      revision,
      text: `completed-${index}-${'x'.repeat(930)}`,
      rationale: `rationale-${index}-${'r'.repeat(930)}`,
      priority: index,
    }),
  );
}

export function largeRequiredFacts(eventId: number, revision: number): ContinuationFact[] {
  return Array.from({ length: 64 }, (_, index) =>
    makeFact({
      id: `state.required.${index}`,
      status: index % 2 === 0 ? 'active' : 'blocked',
      eventId,
      revision,
      text: `required-${index}-${'x'.repeat(930)}`,
      rationale: `rationale-${index}-${'r'.repeat(930)}`,
      priority: index,
    }),
  );
}

export function patchAddingFacts(
  factsBySection: Partial<Record<ContinuationCheckpointSection, ContinuationFact[]>>,
): ContinuationCheckpointPatch {
  return {
    formatVersion: 1,
    additions: CONTINUATION_CHECKPOINT_SECTIONS.flatMap((section) =>
      (factsBySection[section] ?? []).map((fact) => ({
        section,
        fact: {
          ...fact,
          rationale: fact.rationale ?? '',
          validation: fact.validation ?? '',
        },
      })),
    ),
    updates: [],
  };
}

export function checkpointAtExactTokens(target: number): ContinuationCheckpoint {
  const checkpoint = emptyCheckpoint();
  const facts = Array.from({ length: 96 }, (_, index) =>
    makeFact({
      id: `required.fence.${index}`,
      status: 'active',
      eventId: 1,
      revision: 1,
      text: 'x',
      priority: index,
    }),
  );
  checkpoint.goals = facts.slice(0, 64);
  checkpoint.currentState = facts.slice(64);

  const setPadding = (padding: number) => {
    let remaining = padding;
    for (const fact of facts) {
      const extra = Math.min(999, remaining);
      fact.text = 'x'.repeat(1 + extra);
      remaining -= extra;
    }
  };
  let low = 0;
  let high = facts.length * 999;
  let best = 0;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    setPadding(midpoint);
    const tokens = estimateContinuationJsonTokens(checkpoint, { structuralOverhead: 8 });
    if (tokens <= target) {
      best = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  setPadding(best);
  if (estimateContinuationJsonTokens(checkpoint, { structuralOverhead: 8 }) !== target) {
    throw new Error(`Could not construct an exact ${target}-token checkpoint fixture`);
  }
  return checkpoint;
}

export class StaticGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'proven-no-tools' as const;

  constructor(
    private readonly output: ContinuationCheckpointPatch,
    private readonly beforeReturn?: () => void,
  ) {}

  readonly generate = vi.fn(
    async (_request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> => {
      this.beforeReturn?.();
      return {
        output: this.output,
        rawText: JSON.stringify(this.output),
        inputTokens: null,
        outputTokens: null,
        contextWindowTokens: null,
        latencyMs: 1,
        providerCalls: 1,
        structured: true,
      };
    },
  );
}

export const coverageMarker: ContinuationFact = {
  id: 'continuation.coverage-gap.after0.r1.0123456789abcdef',
  status: 'blocked',
  text: 'Revision 1 has a durable bounded coverage gap.',
  rationale: 'The app retained a digest instead of full semantic coverage.',
  validation: 'Consult persisted source events.',
  priority: 100,
  evidence: [{ eventId: 1, revision: 1 }],
};
