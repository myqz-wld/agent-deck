import {
  continuationCheckpointPatchSchema,
  type ContinuationCheckpointPatch,
} from './checkpoint-patch-schema';
import {
  CheckpointPatchValidationError,
  checkpointPatchSchemaError,
} from './checkpoint-patch-validation';

export type CheckpointGeneratorErrorCode =
  | 'timeout'
  | 'aborted'
  | 'output-too-large'
  | 'schema-unsupported'
  | 'provider-error'
  | 'tool-use-observed';

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
  readonly isolation: 'proven-no-tools' | 'hardened-unattested' | 'fail-closed';
  generate(request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult>;
}

function parseGeneratorOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output) as unknown;
  } catch (error) {
    throw new CheckpointPatchValidationError([
      {
        code: 'schema.invalid-json',
        path: '$',
        message: error instanceof Error ? error.message : 'Output is not valid JSON.',
        requiredAction:
          'Return exactly one valid CheckpointPatch JSON object with no prose or fences.',
      },
    ]);
  }
}

/** Parse all structured-output issues so repair receives precise paths instead of one failure. */
export function parseGeneratedContinuationCheckpointPatch(
  output: unknown,
): ContinuationCheckpointPatch {
  const parsed = continuationCheckpointPatchSchema.safeParse(parseGeneratorOutput(output));
  if (!parsed.success) throw checkpointPatchSchemaError(parsed.error);
  return parsed.data;
}

export function rawGeneratorOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
