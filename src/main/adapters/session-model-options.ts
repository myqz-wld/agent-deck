import type { AgentId } from './options-builder';
import {
  type ClaudeThinkingLevel,
  type CodexThinkingLevel,
  type GrokThinkingLevel,
} from '@shared/session-metadata';
import { getAdapterRuntimeProfile } from './runtime-profiles';

export interface SessionModelOptions {
  provider: string | null;
  model: string | null;
  thinking: string | null;
}

export interface CreateSessionModelOptions {
  provider?: string;
  model?: string;
  claudeCodeEffortLevel?: ClaudeThinkingLevel;
  modelReasoningEffort?: CodexThinkingLevel;
  reasoningEffort?: GrokThinkingLevel;
}

export class SessionModelOptionsError extends Error {
  constructor(
    readonly field: 'provider' | 'model' | 'thinking',
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
  input: { provider?: unknown; model?: unknown; thinking?: unknown },
): SessionModelOptions {
  let provider: string | null = null;
  if (input.provider !== undefined && input.provider !== null) {
    if (typeof input.provider !== 'string') {
      throw new SessionModelOptionsError('provider', 'must be a string or null');
    }
    provider = input.provider.trim() || null;
    if (provider && provider.length > 128) {
      throw new SessionModelOptionsError('provider', 'length > 128');
    }
    if (provider && /[\u0000-\u001f\u007f]/.test(provider)) {
      throw new SessionModelOptionsError('provider', 'must not contain control characters');
    }
    if (provider && adapterId === 'grok-build') {
      throw new SessionModelOptionsError(
        'provider',
        'is not supported for grok-build; select a Grok model alias instead',
      );
    }
    if (
      provider &&
      adapterId === 'claude-code' &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider)
    ) {
      throw new SessionModelOptionsError(
        'provider',
        'must be a safe Claude Gateway profile id',
      );
    }
  }

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

  return { provider, model, thinking };
}

/** Map provider-neutral UI values to the adapter-native createSession option names. */
export function resolveCreateSessionModelOptions(
  adapterId: AgentId,
  input: { provider?: unknown; model?: unknown; thinking?: unknown },
): CreateSessionModelOptions {
  const normalized = normalizeSessionModelOptions(adapterId, input);
  const model = normalized.model;
  if (adapterId === 'codex-cli') {
    return {
      ...(normalized.provider !== null ? { provider: normalized.provider } : {}),
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
    ...(normalized.provider !== null ? { provider: normalized.provider } : {}),
    ...(model !== null ? { model } : {}),
    ...(normalized.thinking !== null
      ? { claudeCodeEffortLevel: normalized.thinking as ClaudeThinkingLevel }
      : {}),
  };
}
