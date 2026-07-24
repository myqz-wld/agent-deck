import {
  DEFAULT_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  DEFAULT_SETTINGS,
  MAX_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  MAX_CONTINUATION_RAW_RETENTION_TOKENS,
  MIN_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  MIN_CONTINUATION_RAW_RETENTION_TOKENS,
  type AppSettings,
} from '@shared/types';
import {
  DEFAULT_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
} from '@shared/types/settings/defaults';
import log from '@main/utils/logger';
import {
  isPersistedGeneratorAdapter,
  legacyGeneratorSelection,
  migratePersistedGeneratorThinking,
} from './settings-generator-validation';

const logger = log.scope('settings-generator-migration');

interface LooseStore {
  set(key: string, value: unknown): void;
}

/** Presence-aware one-time migration; persisted new keys always win over legacy values. */
export function migrateGeneratorSettings(
  persistedRaw: Readonly<Record<string, unknown>>,
  target: LooseStore,
): void {
  migrateContinuationSettings(persistedRaw, target);
  migrateRemovedCodexMinimalGeneratorSettings(persistedRaw, target);
  migrateGeneratorBlankFallbacks(persistedRaw, target);
}

function migrateContinuationSettings(
  persistedRaw: Readonly<Record<string, unknown>>,
  target: LooseStore,
): void {
  const legacyContinuationSource =
    'continuationCheckpointProvider' in persistedRaw
      ? persistedRaw.continuationCheckpointProvider
      : persistedRaw.handOffProvider;
  const legacyContinuation = legacyGeneratorSelection(legacyContinuationSource);
  const continuationAdapterSource = persistedRaw.continuationCheckpointAdapter;
  const hasContinuationAdapter = 'continuationCheckpointAdapter' in persistedRaw;
  const continuationAdapter = isPersistedGeneratorAdapter(continuationAdapterSource)
    ? continuationAdapterSource
    : hasContinuationAdapter
      ? DEFAULT_SETTINGS.continuationCheckpointAdapter
      : legacyContinuation.adapter;
  if (
    !isPersistedGeneratorAdapter(continuationAdapterSource) &&
    (continuationAdapterSource !== undefined || legacyContinuationSource !== undefined)
  ) {
    target.set('continuationCheckpointAdapter', continuationAdapter);
  }
  const continuationRuntimeProvider = normalizePersistedRuntimeProvider(
    continuationAdapter,
    persistedRaw.continuationCheckpointRuntimeProvider,
    legacyContinuation.runtimeProvider,
  );
  if (
    persistedRaw.continuationCheckpointRuntimeProvider !== continuationRuntimeProvider &&
    (persistedRaw.continuationCheckpointRuntimeProvider !== undefined ||
      legacyContinuationSource !== undefined)
  ) {
    target.set('continuationCheckpointRuntimeProvider', continuationRuntimeProvider);
  }

  const modelSource = 'continuationCheckpointModel' in persistedRaw
    ? persistedRaw.continuationCheckpointModel
    : persistedRaw.handOffModel;
  const hasModelSource =
    'continuationCheckpointModel' in persistedRaw || 'handOffModel' in persistedRaw;
  const model =
    typeof modelSource === 'string' && modelSource.length <= 256
      ? modelSource
      : DEFAULT_SETTINGS.continuationCheckpointModel;
  if (
    hasModelSource &&
    (!('continuationCheckpointModel' in persistedRaw) || modelSource !== model)
  ) {
    target.set('continuationCheckpointModel', model);
  }

  const thinkingSource = 'continuationCheckpointThinking' in persistedRaw
    ? persistedRaw.continuationCheckpointThinking
    : persistedRaw.handOffReasoning;
  const hasThinkingSource =
    'continuationCheckpointThinking' in persistedRaw || 'handOffReasoning' in persistedRaw;
  const thinking = migratePersistedGeneratorThinking(
    continuationAdapter,
    thinkingSource,
    !('continuationCheckpointThinking' in persistedRaw) && 'handOffReasoning' in persistedRaw,
  );
  if (
    hasThinkingSource &&
    (!('continuationCheckpointThinking' in persistedRaw) || thinkingSource !== thinking)
  ) {
    target.set('continuationCheckpointThinking', thinking);
  }

  const legacySummarySource = persistedRaw.summaryProvider;
  const legacySummary = legacyGeneratorSelection(legacySummarySource);
  const summaryAdapterSource = persistedRaw.summaryAdapter;
  const hasSummaryAdapter = 'summaryAdapter' in persistedRaw;
  const summaryAdapter = isPersistedGeneratorAdapter(summaryAdapterSource)
    ? summaryAdapterSource
    : hasSummaryAdapter
      ? DEFAULT_SETTINGS.summaryAdapter
      : legacySummary.adapter;
  if (
    !isPersistedGeneratorAdapter(summaryAdapterSource) &&
    (summaryAdapterSource !== undefined || legacySummarySource !== undefined)
  ) {
    target.set('summaryAdapter', summaryAdapter);
  }
  const summaryRuntimeProvider = normalizePersistedRuntimeProvider(
    summaryAdapter,
    persistedRaw.summaryRuntimeProvider,
    legacySummary.runtimeProvider,
  );
  if (
    persistedRaw.summaryRuntimeProvider !== summaryRuntimeProvider &&
    (persistedRaw.summaryRuntimeProvider !== undefined || legacySummarySource !== undefined)
  ) {
    target.set('summaryRuntimeProvider', summaryRuntimeProvider);
  }
  const summaryThinkingSource = persistedRaw.summaryThinking ?? persistedRaw.summaryReasoning;
  if (
    summaryThinkingSource !== undefined &&
    (!isThinkingValidForGenerator(summaryAdapter, summaryThinkingSource) ||
      persistedRaw.summaryThinking === undefined)
  ) {
    target.set(
      'summaryThinking',
      migratePersistedGeneratorThinking(summaryAdapter, summaryThinkingSource, true),
    );
  }

  if ('continuationRawRetentionTokens' in persistedRaw) {
    const rawTokens = persistedRaw.continuationRawRetentionTokens;
    if (
      !Number.isSafeInteger(rawTokens) ||
      (rawTokens as number) < MIN_CONTINUATION_RAW_RETENTION_TOKENS ||
      (rawTokens as number) > MAX_CONTINUATION_RAW_RETENTION_TOKENS
    ) {
      target.set(
        'continuationRawRetentionTokens',
        DEFAULT_SETTINGS.continuationRawRetentionTokens,
      );
    }
  }
  if (
    'continuationCheckpointAutoRefreshEnabled' in persistedRaw &&
    typeof persistedRaw.continuationCheckpointAutoRefreshEnabled !== 'boolean'
  ) {
    target.set('continuationCheckpointAutoRefreshEnabled', true);
  }
  if ('continuationCheckpointAutoRefreshIntervalMinutes' in persistedRaw) {
    const minutes = persistedRaw.continuationCheckpointAutoRefreshIntervalMinutes;
    if (
      !Number.isSafeInteger(minutes) ||
      (minutes as number) < MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES ||
      (minutes as number) > MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES
    ) {
      target.set(
        'continuationCheckpointAutoRefreshIntervalMinutes',
        DEFAULT_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
      );
    }
  }
  if ('continuationCheckpointMaxConcurrent' in persistedRaw) {
    const maxConcurrent = persistedRaw.continuationCheckpointMaxConcurrent;
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      (maxConcurrent as number) < MIN_CONTINUATION_CHECKPOINT_MAX_CONCURRENT ||
      (maxConcurrent as number) > MAX_CONTINUATION_CHECKPOINT_MAX_CONCURRENT
    ) {
      target.set(
        'continuationCheckpointMaxConcurrent',
        DEFAULT_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
      );
    }
  }
  if ('summaryEnabled' in persistedRaw && typeof persistedRaw.summaryEnabled !== 'boolean') {
    target.set('summaryEnabled', true);
  }
  if (
    'summaryModel' in persistedRaw &&
    (typeof persistedRaw.summaryModel !== 'string' || persistedRaw.summaryModel.length > 256)
  ) {
    target.set('summaryModel', DEFAULT_SETTINGS.summaryModel);
  }
}

function normalizePersistedRuntimeProvider(
  adapter: AppSettings['summaryAdapter'],
  value: unknown,
  fallback: string,
): string {
  if (adapter === 'grok-build') return '';
  const candidate =
    value === undefined ? fallback.trim() : typeof value === 'string' ? value.trim() : '';
  return candidate.length <= 128 && !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : '';
}

function isThinkingValidForGenerator(
  adapter: AppSettings['summaryAdapter'],
  value: unknown,
): boolean {
  return migratePersistedGeneratorThinking(adapter, value, false) === value;
}

const GENERATOR_BLANK_FALLBACKS_20260714_SENTINEL =
  '__generatorBlankFallbacks20260714Done';

function migrateGeneratorBlankFallbacks(
  persistedRaw: Readonly<Record<string, unknown>>,
  target: LooseStore,
): void {
  if (persistedRaw[GENERATOR_BLANK_FALLBACKS_20260714_SENTINEL] === true) return;
  const existingStore = Object.keys(persistedRaw).length > 0;
  const continuationProviderSource =
    'continuationCheckpointProvider' in persistedRaw
      ? persistedRaw.continuationCheckpointProvider
      : persistedRaw.handOffProvider;
  const continuationAdapter = isPersistedGeneratorAdapter(
    persistedRaw.continuationCheckpointAdapter,
  )
    ? persistedRaw.continuationCheckpointAdapter
    : legacyGeneratorSelection(continuationProviderSource).adapter;
  const continuationModel = 'continuationCheckpointModel' in persistedRaw
    ? persistedRaw.continuationCheckpointModel
    : persistedRaw.handOffModel;
  const isBlank = (value: unknown): boolean => value === undefined || !String(value).trim();
  if (existingStore && continuationAdapter === 'claude-code' && isBlank(continuationModel)) {
    target.set('continuationCheckpointModel', 'opus');
  }
  target.set(GENERATOR_BLANK_FALLBACKS_20260714_SENTINEL, true);
}

function migrateRemovedCodexMinimalGeneratorSettings(
  persistedRaw: Readonly<Record<string, unknown>>,
  target: LooseStore,
): void {
  if (
    persistedRaw.summaryThinking === 'minimal' ||
    persistedRaw.summaryReasoning === 'minimal'
  ) {
    target.set('summaryThinking', 'low');
    logger.info('[settings] migrated summaryThinking minimal → low (Codex effort removal)');
  }
}
