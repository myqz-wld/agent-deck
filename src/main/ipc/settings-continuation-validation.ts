import {
  MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  MAX_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  MAX_CONTINUATION_RAW_RETENTION_TOKENS,
  MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  MIN_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  MIN_CONTINUATION_RAW_RETENTION_TOKENS,
  type AppSettings,
  type GeneratorAdapterId,
} from '@shared/types';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
} from '@shared/session-metadata';
import { IpcInputError } from './_helpers';
import { CLAUDE_GATEWAY_PROFILE_ID_PATTERN } from '@main/adapters/claude-code/gateway-profiles';

const GENERATOR_ADAPTERS: readonly GeneratorAdapterId[] = [
  'claude-code',
  'codex-cli',
  'grok-build',
];

function isGeneratorAdapter(value: unknown): value is GeneratorAdapterId {
  return GENERATOR_ADAPTERS.includes(value as GeneratorAdapterId);
}

function isValidGeneratorThinking(
  adapter: GeneratorAdapterId,
  thinking: unknown,
): boolean {
  if (adapter === 'codex-cli') return isCodexThinkingLevel(thinking);
  if (adapter === 'grok-build') return isGrokThinkingLevel(thinking);
  return isClaudeThinkingLevel(thinking);
}

function assertRuntimeProvider(
  field: string,
  adapter: GeneratorAdapterId,
  value: unknown,
): void {
  if (typeof value !== 'string') {
    throw new IpcInputError(field, 'must be string');
  }
  if (value.length > 128 || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new IpcInputError(field, 'must be a printable string of at most 128 characters');
  }
  if (adapter === 'grok-build' && value.trim()) {
    throw new IpcInputError(field, 'must be empty for grok-build');
  }
  if (
    adapter === 'claude-code' &&
    value.trim() &&
    !CLAUDE_GATEWAY_PROFILE_ID_PATTERN.test(value.trim())
  ) {
    throw new IpcInputError(field, 'must be a safe Claude Gateway profile id');
  }
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

  if (
    'summaryAdapter' in patch ||
    'summaryRuntimeProvider' in patch ||
    'summaryThinking' in patch
  ) {
    const adapter =
      'summaryAdapter' in patch ? patch.summaryAdapter : current.summaryAdapter;
    if (!isGeneratorAdapter(adapter)) {
      throw new IpcInputError(
        'summaryAdapter',
        `must be one of ${GENERATOR_ADAPTERS.join('|')}`,
      );
    }
    const runtimeProvider =
      'summaryRuntimeProvider' in patch
        ? patch.summaryRuntimeProvider
        : current.summaryRuntimeProvider;
    assertRuntimeProvider('summaryRuntimeProvider', adapter, runtimeProvider);
    const thinking =
      'summaryThinking' in patch ? patch.summaryThinking : current.summaryThinking;
    if (!isValidGeneratorThinking(adapter, thinking)) {
      throw new IpcInputError(
        'summaryThinking',
        `incompatible with adapter ${String(adapter)}`,
      );
    }
  }

  const continuationChanged = Object.keys(raw).some(
    (key) => key.startsWith('continuationCheckpoint') || key === 'continuationRawRetentionTokens',
  );
  if (!continuationChanged) return;

  const adapter =
    'continuationCheckpointAdapter' in patch
      ? patch.continuationCheckpointAdapter
      : current.continuationCheckpointAdapter;
  if (!isGeneratorAdapter(adapter)) {
    throw new IpcInputError(
      'continuationCheckpointAdapter',
      `must be one of ${GENERATOR_ADAPTERS.join('|')}`,
    );
  }
  const runtimeProvider =
    'continuationCheckpointRuntimeProvider' in patch
      ? patch.continuationCheckpointRuntimeProvider
      : current.continuationCheckpointRuntimeProvider;
  assertRuntimeProvider(
    'continuationCheckpointRuntimeProvider',
    adapter,
    runtimeProvider,
  );
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
  if (!isValidGeneratorThinking(adapter, thinking)) {
    throw new IpcInputError(
      'continuationCheckpointThinking',
      `incompatible with adapter ${String(adapter)}`,
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
