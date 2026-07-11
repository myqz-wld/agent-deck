import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  canonicalizeContinuationCheckpoint,
  type CanonicalContinuationCheckpoint,
  type ContinuationCheckpoint,
  type ContinuationCheckpointSection,
} from './checkpoint-schema';

export type CheckpointGeneratorErrorCode =
  | 'timeout'
  | 'aborted'
  | 'output-too-large'
  | 'schema-unsupported'
  | 'provider-error'
  | 'tool-use-observed'
  | 'codex-generator-tools-unproven';

export class CheckpointGeneratorError extends Error {
  constructor(
    message: string,
    readonly code: CheckpointGeneratorErrorCode,
    readonly providerCalls = 0,
  ) {
    super(message);
    this.name = 'CheckpointGeneratorError';
  }
}

export interface CheckpointGeneratorRequest {
  prompt: string;
  timeoutMs: number;
  maxOutputBytes: number;
  remainingCalls: number;
  signal?: AbortSignal;
}

export interface CheckpointGeneratorResult {
  output: unknown;
  rawText: string;
  inputTokens: number | null;
  outputTokens: number | null;
  contextWindowTokens: number | null;
  latencyMs: number;
  providerCalls: number;
  structured: boolean;
}

export interface ContinuationCheckpointGenerator {
  readonly isolation: 'proven-no-tools' | 'fail-closed';
  generate(request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult>;
}

function evidenceKey(evidence: { eventId: number; revision: number }): string {
  return `${evidence.eventId}:${evidence.revision}`;
}

function currentDeltaEvidenceSet(
  currentDeltaEvidence: Array<{ eventId: number; revision: number }>,
): Set<string> {
  return new Set(currentDeltaEvidence.map(evidenceKey));
}

function assertEvidenceAllowed(
  checkpoint: ContinuationCheckpoint,
  allowedEvidence: Set<string>,
): void {
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    for (const fact of checkpoint[section]) {
      for (const evidence of fact.evidence) {
        if (!allowedEvidence.has(evidenceKey(evidence))) {
          throw new Error(
            `Checkpoint fact ${fact.id} cites evidence outside the exact fold allowlist`,
          );
        }
      }
    }
  }
}

const PROTECTED_SECTIONS: readonly ContinuationCheckpointSection[] = [
  'constraints',
  'openQuestions',
  'risks',
];

function assertProtectedFactsCarryForward(
  previous: ContinuationCheckpoint | null,
  next: ContinuationCheckpoint,
  deltaEvidence: Set<string>,
): void {
  if (!previous) return;
  for (const section of PROTECTED_SECTIONS) {
    const nextById = new Map(next[section].map((fact) => [fact.id, fact]));
    for (const prior of previous[section]) {
      if (prior.status !== 'active' && prior.status !== 'blocked') continue;
      const candidate = nextById.get(prior.id);
      if (!candidate) {
        throw new Error(`Active ${section} fact ${prior.id} was removed without explicit evidence`);
      }
      const semanticChanged =
        candidate.text !== prior.text ||
        candidate.rationale !== prior.rationale ||
        candidate.validation !== prior.validation ||
        candidate.status !== prior.status;
      if (
        semanticChanged &&
        !candidate.evidence.some((evidence) => deltaEvidence.has(evidenceKey(evidence)))
      ) {
        throw new Error(
          `Active ${section} fact ${prior.id} changed without current-delta evidence`,
        );
      }
      if (candidate.status === 'resolved' || candidate.status === 'superseded') {
        if (!candidate.evidence.some((evidence) => deltaEvidence.has(evidenceKey(evidence)))) {
          throw new Error(
            `Active ${section} fact ${prior.id} changed status without current-delta evidence`,
          );
        }
      }
    }
  }
}

function parseGeneratorOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  return JSON.parse(output) as unknown;
}

/** Validate schema, exact evidence membership, and protected active-fact carry-forward. */
export function validateGeneratedContinuationCheckpoint(input: {
  output: unknown;
  previousCheckpoint: ContinuationCheckpoint | null;
  allowedEvidence: Array<{ eventId: number; revision: number }>;
  currentDeltaEvidence: Array<{ eventId: number; revision: number }>;
}): CanonicalContinuationCheckpoint {
  const canonical = canonicalizeContinuationCheckpoint(parseGeneratorOutput(input.output));
  assertEvidenceAllowed(
    canonical.checkpoint,
    new Set(input.allowedEvidence.map(evidenceKey)),
  );
  assertProtectedFactsCarryForward(
    input.previousCheckpoint,
    canonical.checkpoint,
    currentDeltaEvidenceSet(input.currentDeltaEvidence),
  );
  return canonical;
}

export function rawGeneratorOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
