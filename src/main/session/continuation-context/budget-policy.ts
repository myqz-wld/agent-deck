import { estimateContinuationTokens, utf8ByteLength } from './token-estimator';

export const DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS = 64_000;
export const MIN_CONTINUATION_RAW_RETENTION_TOKENS = 8_000;
export const MAX_CONTINUATION_RAW_RETENTION_TOKENS = 128_000;
export const DEFAULT_GENERATOR_FOLD_INPUT_TOKENS = 32_000;
export const CONTINUATION_PROMPT_MAX_UTF8_BYTES = 512 * 1024;
export const DEFAULT_SYSTEM_PROJECT_RESERVE_TOKENS = 16_000;
export const DEFAULT_RESPONSE_RESERVE_TOKENS = 8_000;
export const MIN_CHECKPOINT_PROJECTION_TOKENS = 2_000;
export const MAX_CHECKPOINT_PROJECTION_TOKENS = 12_000;

export class ContinuationBudgetError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-raw-retention' | 'instruction-does-not-fit' | 'prompt-byte-limit',
  ) {
    super(message);
    this.name = 'ContinuationBudgetError';
  }
}

export interface ResolveContinuationBudgetsInput {
  rawRetentionCeilingTokens: number;
  targetContextWindowTokens: number;
  generatorContextWindowTokens: number | null;
  continuationInstruction: string;
  fixedWrapperTokens: number;
  systemProjectReserveTokens?: number;
  responseReserveTokens?: number;
}

export interface ResolvedContinuationBudgets {
  rawRetentionCeilingTokens: number;
  targetPromptCapacityTokens: number;
  checkpointProjectionBudgetTokens: number;
  generatorFoldInputBudgetTokens: number;
  instructionTokens: number;
  fixedWrapperTokens: number;
  historicalCapacityTokens: number;
  initialRawTailBudgetTokens: number;
}

function safeNonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

export function validateRawRetentionCeiling(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_CONTINUATION_RAW_RETENTION_TOKENS ||
    value > MAX_CONTINUATION_RAW_RETENTION_TOKENS
  ) {
    throw new ContinuationBudgetError(
      `rawRetentionCeilingTokens must be an integer from ${MIN_CONTINUATION_RAW_RETENTION_TOKENS} to ${MAX_CONTINUATION_RAW_RETENTION_TOKENS}`,
      'invalid-raw-retention',
    );
  }
  return value;
}

export function resolveTargetPromptCapacityTokens(
  contextWindowTokens: number,
  systemProjectReserveTokens = DEFAULT_SYSTEM_PROJECT_RESERVE_TOKENS,
  responseReserveTokens = DEFAULT_RESPONSE_RESERVE_TOKENS,
): number {
  safeNonNegative(contextWindowTokens, 'contextWindowTokens');
  safeNonNegative(systemProjectReserveTokens, 'systemProjectReserveTokens');
  safeNonNegative(responseReserveTokens, 'responseReserveTokens');
  return Math.max(0, contextWindowTokens - systemProjectReserveTokens - responseReserveTokens);
}

export function resolveGeneratorFoldInputBudgetTokens(contextWindowTokens: number | null): number {
  if (contextWindowTokens == null) return DEFAULT_GENERATOR_FOLD_INPUT_TOKENS;
  safeNonNegative(contextWindowTokens, 'generatorContextWindowTokens');
  // Reserve half for app-owned instructions, checkpoint output, and provider accounting variance.
  return Math.max(1, Math.floor(contextWindowTokens / 2));
}

export function resolveContinuationBudgets(
  input: ResolveContinuationBudgetsInput,
): ResolvedContinuationBudgets {
  const rawRetentionCeilingTokens = validateRawRetentionCeiling(input.rawRetentionCeilingTokens);
  const fixedWrapperTokens = safeNonNegative(input.fixedWrapperTokens, 'fixedWrapperTokens');
  const instructionTokens = estimateContinuationTokens(JSON.stringify(input.continuationInstruction));
  const targetPromptCapacityTokens = resolveTargetPromptCapacityTokens(
    input.targetContextWindowTokens,
    input.systemProjectReserveTokens,
    input.responseReserveTokens,
  );
  const historicalCapacityTokens = targetPromptCapacityTokens - fixedWrapperTokens - instructionTokens;
  if (historicalCapacityTokens < 0) {
    throw new ContinuationBudgetError(
      `Continuation wrapper and current instruction require ${fixedWrapperTokens + instructionTokens} estimated tokens, exceeding target prompt capacity ${targetPromptCapacityTokens}`,
      'instruction-does-not-fit',
    );
  }
  const desiredProjection = Math.round(historicalCapacityTokens * 0.2);
  const checkpointProjectionBudgetTokens = Math.min(
    historicalCapacityTokens,
    MAX_CHECKPOINT_PROJECTION_TOKENS,
    Math.max(MIN_CHECKPOINT_PROJECTION_TOKENS, desiredProjection),
  );
  const initialRawTailBudgetTokens = Math.min(
    rawRetentionCeilingTokens,
    Math.max(0, historicalCapacityTokens - checkpointProjectionBudgetTokens),
  );
  return {
    rawRetentionCeilingTokens,
    targetPromptCapacityTokens,
    checkpointProjectionBudgetTokens,
    generatorFoldInputBudgetTokens: resolveGeneratorFoldInputBudgetTokens(
      input.generatorContextWindowTokens,
    ),
    instructionTokens,
    fixedWrapperTokens,
    historicalCapacityTokens,
    initialRawTailBudgetTokens,
  };
}

export function assertContinuationPromptByteLimit(prompt: string): void {
  const bytes = utf8ByteLength(prompt);
  if (bytes > CONTINUATION_PROMPT_MAX_UTF8_BYTES) {
    throw new ContinuationBudgetError(
      `Continuation provider prompt is ${bytes} UTF-8 bytes, exceeding ${CONTINUATION_PROMPT_MAX_UTF8_BYTES}`,
      'prompt-byte-limit',
    );
  }
}
