import { ZodError } from 'zod';
import { MAX_CHECKPOINT_PATCH_OPERATIONS } from './checkpoint-patch-schema';
import { MAX_CHECKPOINT_FACTS_PER_SECTION } from './checkpoint-schema';

/** Human-readable mirror of every validator class that the model can act on before generation. */
export const CHECKPOINT_PATCH_VALIDATION_RULES = [
  'Return only {formatVersion, additions, updates}; never return a full checkpoint.',
  'Use additions only for globally new ids. Use updates only for ids already present in the named section. Existing facts cannot move between sections.',
  'Omit every unchanged fact. In updates, use null for each unchanged semantic field and provide only fields that change; at least one field must change.',
  'There is no delete operation. Use an evidence-backed status update to complete, resolve, or supersede an existing fact.',
  'Every addition and update must cite one or more distinct exact pairs from currentDeltaEvidence. Prior checkpoint evidence is invalid patch evidence.',
  'Ids beginning with "continuation.coverage-gap." are app-owned and cannot be added or updated.',
  `Use at most ${MAX_CHECKPOINT_PATCH_OPERATIONS} total operations, target each id at most once, and do not add beyond a section's ${MAX_CHECKPOINT_FACTS_PER_SECTION}-fact capacity.`,
  'In additions, use an empty string for an absent rationale or validation. In updates, use an empty string to clear rationale or validation; null preserves it. Empty additions and updates are valid when the current delta establishes no semantic change.',
] as const;

export interface CheckpointPatchValidationIssue {
  code: string;
  path: string;
  message: string;
  requiredAction: string;
}

function issuePath(path: PropertyKey[]): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') return `${result}[${segment}]`;
    return `${result}.${String(segment)}`;
  }, '$');
}

export class CheckpointPatchValidationError extends Error {
  readonly issues: CheckpointPatchValidationIssue[];

  constructor(issues: CheckpointPatchValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
      .join('; ');
    super(`Checkpoint patch validation failed with ${issues.length} issue(s): ${summary}`);
    this.name = 'CheckpointPatchValidationError';
    this.issues = issues;
  }
}

function schemaRequiredAction(issue: ZodError['issues'][number]): string {
  if (issue.message.startsWith('Duplicate checkpoint patch target:')) {
    return 'Keep exactly one addition or update for that id; each patch may target an id once.';
  }
  if (issue.message.startsWith('Checkpoint patch exceeds')) {
    return `Reduce additions and updates to at most ${MAX_CHECKPOINT_PATCH_OPERATIONS} total operations.`;
  }
  if (issue.message.includes('declares no semantic field')) {
    return 'Set at least one changed semantic field, or remove this unchanged update.';
  }
  if (issue.code === 'too_big' && issue.path[0] === 'additions') {
    return 'Reduce additions so the patch stays within the supplied operation limit.';
  }
  if (issue.code === 'too_big' && issue.path[0] === 'updates') {
    return 'Reduce updates so the patch stays within the supplied operation limit.';
  }
  return `Return a value at ${issuePath(issue.path)} that matches the supplied JSON schema.`;
}

export function checkpointPatchSchemaError(error: ZodError): CheckpointPatchValidationError {
  return new CheckpointPatchValidationError(
    error.issues.map((issue) => ({
      code: `schema.${issue.code}`,
      path: issuePath(issue.path),
      message: issue.message,
      requiredAction: schemaRequiredAction(issue),
    })),
  );
}

export function checkpointPatchValidationIssues(
  error: unknown,
): CheckpointPatchValidationIssue[] {
  if (error instanceof CheckpointPatchValidationError) return error.issues;
  if (error instanceof ZodError) return checkpointPatchSchemaError(error).issues;
  return [
    {
      code: 'validation.unexpected',
      path: '$',
      message: error instanceof Error ? error.message : String(error),
      requiredAction: 'Return a patch that satisfies the supplied schema and semantic rules.',
    },
  ];
}
