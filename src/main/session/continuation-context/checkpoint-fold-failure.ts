import log from '@main/utils/logger';
import { CheckpointGeneratorError } from './checkpoint-generator';
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
