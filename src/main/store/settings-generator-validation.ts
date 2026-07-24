import {
  DEFAULT_CONTINUATION_CHECKPOINT_THINKING,
  type AppSettings,
  type GeneratorAdapterId,
} from '@shared/types';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
} from '@shared/session-metadata';

const GENERATOR_ADAPTERS: readonly GeneratorAdapterId[] = [
  'claude-code',
  'codex-cli',
  'grok-build',
];
export function isPersistedGeneratorAdapter(
  value: unknown,
): value is GeneratorAdapterId {
  return GENERATOR_ADAPTERS.includes(value as GeneratorAdapterId);
}

export function legacyGeneratorSelection(value: unknown): {
  adapter: GeneratorAdapterId;
  runtimeProvider: string;
} {
  switch (value) {
    case 'deepseek':
      return { adapter: 'claude-code', runtimeProvider: 'deepseek' };
    case 'codex':
      return { adapter: 'codex-cli', runtimeProvider: '' };
    case 'grok':
      return { adapter: 'grok-build', runtimeProvider: '' };
    default:
      return { adapter: 'claude-code', runtimeProvider: '' };
  }
}

export function migratePersistedGeneratorThinking(
  adapter: GeneratorAdapterId,
  value: unknown,
  allowLegacyCoercion: boolean,
): AppSettings['continuationCheckpointThinking'] {
  if (value === 'minimal') return 'low';
  if (adapter === 'codex-cli') {
    return isCodexThinkingLevel(value)
      ? value
      : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
  }
  if (adapter === 'grok-build') {
    if (value === 'ultra' || value === 'max') return 'xhigh';
    return isGrokThinkingLevel(value)
      ? value
      : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
  }
  if (allowLegacyCoercion && value === 'ultra') return 'max';
  return isClaudeThinkingLevel(value)
    ? value
    : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
}
