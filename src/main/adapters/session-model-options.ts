import type { AgentId } from './options-builder';
import {
  type ClaudeThinkingLevel,
  type CodexThinkingLevel,
  type GrokThinkingLevel,
} from '@shared/session-metadata';
import { getAdapterRuntimeProfile } from './runtime-profiles';

export interface SessionModelOptions {
  model: string | null;
  thinking: string | null;
}

export interface CreateSessionModelOptions {
  model?: string;
  claudeCodeEffortLevel?: ClaudeThinkingLevel;
  modelReasoningEffort?: CodexThinkingLevel;
  reasoningEffort?: GrokThinkingLevel;
}

export class SessionModelOptionsError extends Error {
  constructor(
    readonly field: 'model' | 'thinking',
    message: string,
  ) {
    super(message);
    this.name = 'SessionModelOptionsError';
  }
}

export function thinkingLevelsForAdapter(adapterId: AgentId): readonly string[] {
  return getAdapterRuntimeProfile(adapterId).model.thinkingLevels;
}

/**
 * Normalize untrusted UI / IPC values. Model ids deliberately remain open-ended: the target
 * provider is authoritative, while Agent Deck only enforces a bounded non-blank string.
 */
export function normalizeSessionModelOptions(
  adapterId: AgentId,
  input: { model?: unknown; thinking?: unknown },
): SessionModelOptions {
  let model: string | null = null;
  if (input.model !== undefined && input.model !== null) {
    if (typeof input.model !== 'string') {
      throw new SessionModelOptionsError('model', 'must be a string or null');
    }
    model = input.model.trim() || null;
    if (model && model.length > 256) {
      throw new SessionModelOptionsError('model', 'length > 256');
    }
  }

  let thinking: string | null = null;
  if (input.thinking !== undefined && input.thinking !== null && input.thinking !== '') {
    if (typeof input.thinking !== 'string') {
      throw new SessionModelOptionsError('thinking', 'must be a string or null');
    }
    const valid = thinkingLevelsForAdapter(adapterId).includes(input.thinking);
    if (!valid) {
      throw new SessionModelOptionsError(
        'thinking',
        `must be one of ${thinkingLevelsForAdapter(adapterId).join('|')}`,
      );
    }
    thinking = input.thinking;
  }

  return { model, thinking };
}

export function mapDeepseekModelAlias(model: string | null): string | null {
  if (model === 'v4-flash') return 'deepseek-v4-flash';
  if (model === 'v4-pro') return 'deepseek-v4-pro[1m]';
  return model;
}

/** Map provider-neutral UI values to the adapter-native createSession option names. */
export function resolveCreateSessionModelOptions(
  adapterId: AgentId,
  input: { model?: unknown; thinking?: unknown },
): CreateSessionModelOptions {
  const normalized = normalizeSessionModelOptions(adapterId, input);
  const model = adapterId === 'deepseek-claude-code'
    ? mapDeepseekModelAlias(normalized.model)
    : normalized.model;
  if (adapterId === 'codex-cli') {
    return {
      ...(model !== null ? { model } : {}),
      ...(normalized.thinking !== null
        ? { modelReasoningEffort: normalized.thinking as CodexThinkingLevel }
        : {}),
    };
  }
  if (adapterId === 'grok-build') {
    return {
      ...(model !== null ? { model } : {}),
      ...(normalized.thinking !== null
        ? { reasoningEffort: normalized.thinking as GrokThinkingLevel }
        : {}),
    };
  }
  return {
    ...(model !== null ? { model } : {}),
    ...(normalized.thinking !== null
      ? { claudeCodeEffortLevel: normalized.thinking as ClaudeThinkingLevel }
      : {}),
  };
}
