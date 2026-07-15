import {
  MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  MAX_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  MAX_CONTINUATION_RAW_RETENTION_TOKENS,
  MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  MIN_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  MIN_CONTINUATION_RAW_RETENTION_TOKENS,
  type AppSettings,
  type ContinuationCheckpointProvider,
} from '@shared/types';
import { isClaudeThinkingLevel, isCodexThinkingLevel } from '@shared/session-metadata';
import { IpcInputError } from './_helpers';

const GENERATOR_PROVIDERS: readonly ContinuationCheckpointProvider[] = [
  'claude',
  'deepseek',
  'codex',
];

function isGeneratorProvider(value: unknown): value is ContinuationCheckpointProvider {
  return GENERATOR_PROVIDERS.includes(value as ContinuationCheckpointProvider);
}

function isValidGeneratorThinking(
  provider: ContinuationCheckpointProvider,
  thinking: unknown,
): boolean {
  return provider === 'codex'
    ? isCodexThinkingLevel(thinking)
    : isClaudeThinkingLevel(thinking);
}

/** Validate the summary and continuation-generator portion of an untrusted settings patch. */
export function validateContinuationAndSummarySettingsPatch(
  raw: Record<string, unknown>,
  patch: Partial<AppSettings>,
  current: AppSettings,
): void {
  if ('summaryEnabled' in patch && typeof patch.summaryEnabled !== 'boolean') {
    throw new IpcInputError('summaryEnabled', 'must be boolean');
  }
  if ('summaryModel' in patch) {
    if (typeof patch.summaryModel !== 'string') {
      throw new IpcInputError('summaryModel', 'must be string');
    }
    if (patch.summaryModel.length > 256) {
      throw new IpcInputError('summaryModel', 'length > 256');
    }
  }

  if ('summaryProvider' in patch || 'summaryReasoning' in patch) {
    const provider =
      'summaryProvider' in patch ? patch.summaryProvider : current.summaryProvider;
    if (!isGeneratorProvider(provider)) {
      throw new IpcInputError(
        'summaryProvider',
        `must be one of ${GENERATOR_PROVIDERS.join('|')}`,
      );
    }
    const thinking =
      'summaryReasoning' in patch ? patch.summaryReasoning : current.summaryReasoning;
    if (!isValidGeneratorThinking(provider, thinking)) {
      throw new IpcInputError(
        'summaryReasoning',
        `incompatible with provider ${String(provider)}`,
      );
    }
  }

  const continuationChanged = Object.keys(raw).some(
    (key) => key.startsWith('continuationCheckpoint') || key === 'continuationRawRetentionTokens',
  );
  if (!continuationChanged) return;

  const provider =
    'continuationCheckpointProvider' in patch
      ? patch.continuationCheckpointProvider
      : current.continuationCheckpointProvider;
  if (!isGeneratorProvider(provider)) {
    throw new IpcInputError(
      'continuationCheckpointProvider',
      `must be one of ${GENERATOR_PROVIDERS.join('|')}`,
    );
  }
  if ('continuationCheckpointModel' in patch) {
    if (typeof patch.continuationCheckpointModel !== 'string') {
      throw new IpcInputError('continuationCheckpointModel', 'must be string');
    }
    if (patch.continuationCheckpointModel.length > 256) {
      throw new IpcInputError('continuationCheckpointModel', 'length > 256');
    }
  }
  if (
    'continuationCheckpointAutoRefreshEnabled' in patch &&
    typeof patch.continuationCheckpointAutoRefreshEnabled !== 'boolean'
  ) {
    throw new IpcInputError('continuationCheckpointAutoRefreshEnabled', 'must be boolean');
  }
  if ('continuationCheckpointAutoRefreshIntervalMinutes' in patch) {
    const value = patch.continuationCheckpointAutoRefreshIntervalMinutes;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES ||
      value > MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES
    ) {
      throw new IpcInputError(
        'continuationCheckpointAutoRefreshIntervalMinutes',
        `out of range [${MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES}, ${MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES}]`,
      );
    }
  }
  if ('continuationCheckpointMaxConcurrent' in patch) {
    const value = patch.continuationCheckpointMaxConcurrent;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < MIN_CONTINUATION_CHECKPOINT_MAX_CONCURRENT ||
      value > MAX_CONTINUATION_CHECKPOINT_MAX_CONCURRENT
    ) {
      throw new IpcInputError(
        'continuationCheckpointMaxConcurrent',
        `out of range [${MIN_CONTINUATION_CHECKPOINT_MAX_CONCURRENT}, ${MAX_CONTINUATION_CHECKPOINT_MAX_CONCURRENT}]`,
      );
    }
  }
  const thinking =
    'continuationCheckpointThinking' in patch
      ? patch.continuationCheckpointThinking
      : current.continuationCheckpointThinking;
  if (!isValidGeneratorThinking(provider, thinking)) {
    throw new IpcInputError(
      'continuationCheckpointThinking',
      `incompatible with provider ${String(provider)}`,
    );
  }
  if ('continuationRawRetentionTokens' in patch) {
    const value = patch.continuationRawRetentionTokens;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new IpcInputError(
        'continuationRawRetentionTokens',
        `must be a safe integer: ${String(value)}`,
      );
    }
    if (
      value < MIN_CONTINUATION_RAW_RETENTION_TOKENS ||
      value > MAX_CONTINUATION_RAW_RETENTION_TOKENS
    ) {
      throw new IpcInputError(
        'continuationRawRetentionTokens',
        `out of range [${MIN_CONTINUATION_RAW_RETENTION_TOKENS}, ${MAX_CONTINUATION_RAW_RETENTION_TOKENS}]`,
      );
    }
  }
}
