export type SessionHandOffSourceCutoverReason =
  | 'source-not-open'
  | 'runtime-changed'
  | 'revision-state-missing'
  | 'revision-regressed'
  | 'rebuild-epoch-changed'
  | 'captured-event-mutated'
  | 'late-attachment-invalid'
  | 'revision-gap'
  | 'source-kept-changing'
  | 'late-message-delivery-failed'
  | 'message-delivery-drain-timeout'
  | 'check-failed';

export type SessionHandOffTrustedContinuationFailureReason =
  | 'target-startup-timeout'
  | 'target-retry-startup-failed'
  | 'target-acceptance-timeout'
  | 'target-context-rejected'
  | 'target-provider-rejected'
  | 'target-rollback-failed'
  | 'target-retry-rejected';

export type SessionHandOffCutoverReason =
  | SessionHandOffSourceCutoverReason
  | SessionHandOffTrustedContinuationFailureReason;

const PRE_EXECUTION_TARGET_REASONS = new Set<SessionHandOffCutoverReason>([
  'target-startup-timeout',
  'target-retry-startup-failed',
  'target-context-rejected',
  'target-rollback-failed',
]);

/**
 * Classify structured UI/MCP failures without coupling their user-facing languages.
 * A stable successor can run before later source/transfer checks; only the listed target failures
 * prove that the trusted turn did not reach a potentially effectful execution phase.
 */
export function handOffSuccessorMayHavePartiallyExecuted(input: {
  successorSessionId: string | null;
  cutoverReason?: SessionHandOffCutoverReason;
}): boolean {
  if (!input.successorSessionId) return false;
  return !input.cutoverReason || !PRE_EXECUTION_TARGET_REASONS.has(input.cutoverReason);
}
