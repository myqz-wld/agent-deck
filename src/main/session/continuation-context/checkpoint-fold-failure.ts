import log from '@main/utils/logger';
import { CheckpointGeneratorError } from './checkpoint-generator';
import { CheckpointPatchValidationError } from './checkpoint-patch-validation';
import type { ContinuationWarning } from './types';

const logger = log.scope('continuation-context');

export type CheckpointFailureStage =
  | 'bounded-marker-commit'
  | 'fold-generate'
  | 'fold-validate'
  | 'fold-commit'
  | 'repair';

export interface CheckpointFoldFailureDiagnostic {
  stage: CheckpointFailureStage;
  category: string;
  reason: string;
  providerCalls: number;
  checkpointRevision: number;
  captureRevision: number;
  deadlineRemainingMs: number;
}

export function classifyCheckpointFailureReason(error: unknown): string {
  if (error instanceof CheckpointGeneratorError) return error.code;
  if (error instanceof CheckpointPatchValidationError) {
    const codes = new Set(error.issues.map((issue) => issue.code));
    if (codes.has('schema.invalid-json')) return 'invalid-json';
    if ([...codes].some((code) => code.startsWith('schema.'))) return 'schema-invalid';
    if (codes.has('evidence.outside-current-delta')) return 'evidence-outside-current-delta';
    if (codes.has('fact.reserved-id')) return 'coverage-marker-invariant';
    if (codes.has('addition.section-capacity')) return 'canonical-capacity';
    if (codes.has('update.no-semantic-change')) return 'patch-no-op';
    if (
      codes.has('update.unknown-fact') ||
      codes.has('update.section-mismatch') ||
      codes.has('addition.existing-fact')
    ) {
      return 'patch-target-invalid';
    }
    return 'patch-semantic-invalid';
  }
  if (error instanceof SyntaxError) return 'invalid-json';
  const message = error instanceof Error ? error.message : String(error);
  if (/cites evidence outside the exact fold allowlist/i.test(message)) {
    return 'evidence-outside-allowlist';
  }
  if (/coverage-gap marker/i.test(message)) return 'coverage-marker-invariant';
  if (/active .* fact .* was removed/i.test(message)) return 'active-fact-removed';
  if (/active .* fact .* changed/i.test(message)) return 'active-fact-changed-without-evidence';
  if (/duplicate checkpoint fact id/i.test(message)) return 'duplicate-fact-id';
  if ((error as { name?: unknown } | null)?.name === 'ZodError') return 'schema-invalid';
  if (/canonical checkpoint (?:fit failed|exceeds)/i.test(message)) return 'canonical-capacity';
  if (/checkpoint cas conflict/i.test(message)) return 'checkpoint-cas-conflict';
  return 'unclassified';
}

function failureCategory(stage: CheckpointFailureStage, error: unknown): string {
  if (error instanceof CheckpointGeneratorError) return error.code;
  if (stage === 'fold-validate' || stage === 'repair') return 'checkpoint-validation';
  if (stage === 'fold-commit' || stage === 'bounded-marker-commit') {
    return 'checkpoint-commit';
  }
  return 'internal-error';
}

export function recordCheckpointFoldFailure(input: {
  warnings: ContinuationWarning[];
  code: 'checkpoint-generation-failed' | 'checkpoint-repair-failed';
  stage: CheckpointFailureStage;
  error: unknown;
  providerCalls: number;
  checkpointRevision: number;
  captureRevision: number;
  deadlineRemainingMs: number;
}): CheckpointFoldFailureDiagnostic {
  const diagnostic: CheckpointFoldFailureDiagnostic = {
    stage: input.stage,
    category: failureCategory(input.stage, input.error),
    reason: classifyCheckpointFailureReason(input.error),
    providerCalls: Math.max(0, input.providerCalls),
    checkpointRevision: input.checkpointRevision,
    captureRevision: input.captureRevision,
    deadlineRemainingMs: Math.max(0, input.deadlineRemainingMs),
  };
  // The background owner emits the persisted warning with retry context. Keep this local detail in
  // the development console so one failure does not become two persisted warning records.
  logger.debug('[continuation-context] checkpoint fold failed', diagnostic);
  input.warnings.push({
    code: input.code,
    message:
      `Checkpoint stage ${diagnostic.stage} failed ` +
      `(category=${diagnostic.category}, reason=${diagnostic.reason}, ` +
      `providerCalls=${diagnostic.providerCalls}).`,
  });
  return diagnostic;
}
