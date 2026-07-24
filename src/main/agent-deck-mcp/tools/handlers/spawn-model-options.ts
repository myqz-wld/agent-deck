import type {
  SpawnSessionArgs,
  SpawnSessionModelValue,
  SpawnSessionThinkingValue,
} from '../schemas';
import {
  type ClaudeThinkingLevel,
  type CodexThinkingLevel,
  type GrokThinkingLevel,
} from '@shared/session-metadata';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';

export type SpawnCodexReasoningEffort = CodexThinkingLevel;
export type SpawnClaudeCodeEffortLevel = ClaudeThinkingLevel;
export type SpawnGrokReasoningEffort = GrokThinkingLevel;

export interface SpawnModelOptions {
  model?: string;
  modelReasoningEffort?: SpawnCodexReasoningEffort;
  claudeCodeEffortLevel?: SpawnClaudeCodeEffortLevel;
  reasoningEffort?: SpawnGrokReasoningEffort;
}

export type SpawnModelOptionsResult =
  | { ok: true; options: SpawnModelOptions }
  | { ok: false; error: string; hint: string };

const DEEPSEEK_MODEL_RUNTIME = {
  'v4-flash': 'deepseek-v4-flash',
  'v4-pro': 'deepseek-v4-pro[1m]',
} as const satisfies Partial<Record<SpawnSessionModelValue, string>>;

function formatValues(values: readonly string[]): string {
  return values.join(', ');
}

function isAllowed<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function resolveExplicitModel(
  adapter: SpawnSessionArgs['adapter'],
  model: string,
): SpawnModelOptionsResult {
  const normalized = model.trim();
  if (adapter === 'deepseek-claude-code') {
    const aliasModel = DEEPSEEK_MODEL_RUNTIME[normalized as SpawnSessionModelValue];
    return { ok: true, options: { model: aliasModel ?? normalized } };
  }
  return { ok: true, options: { model: normalized } };
}

function resolveThinking(
  adapter: SpawnSessionArgs['adapter'],
  thinking: SpawnSessionThinkingValue,
): SpawnModelOptionsResult {
  const allowed = getAdapterRuntimeProfile(adapter).model
    .thinkingLevels as readonly SpawnSessionThinkingValue[];
  if (!isAllowed(allowed, thinking)) {
    return {
      ok: false,
      error: `thinking "${thinking}" is not valid for adapter "${adapter}"`,
      hint: `Use one of: ${formatValues(allowed)}.`,
    };
  }
  if (adapter === 'codex-cli') {
    return { ok: true, options: { modelReasoningEffort: thinking as SpawnCodexReasoningEffort } };
  }
  if (adapter === 'grok-build') {
    return { ok: true, options: { reasoningEffort: thinking as SpawnGrokReasoningEffort } };
  }
  return { ok: true, options: { claudeCodeEffortLevel: thinking as SpawnClaudeCodeEffortLevel } };
}

export function resolveSpawnModelOptions(
  args: SpawnSessionArgs,
  modelFromFrontmatter: string | undefined,
  modelReasoningEffortFromAgent?: SpawnCodexReasoningEffort,
  claudeCodeEffortLevelFromAgent?: SpawnClaudeCodeEffortLevel,
  grokReasoningEffortFromAgent?: SpawnGrokReasoningEffort,
): SpawnModelOptionsResult {
  const options: SpawnModelOptions = {};

  if (args.model !== undefined) {
    const resolved = resolveExplicitModel(args.adapter, args.model);
    if (!resolved.ok) return resolved;
    if (resolved.options.model !== undefined) options.model = resolved.options.model;
  } else if (modelFromFrontmatter) {
    options.model = modelFromFrontmatter;
  }

  if (args.thinking !== undefined) {
    const resolved = resolveThinking(args.adapter, args.thinking);
    if (!resolved.ok) return resolved;
    if (resolved.options.modelReasoningEffort !== undefined) {
      options.modelReasoningEffort = resolved.options.modelReasoningEffort;
    }
    if (resolved.options.claudeCodeEffortLevel !== undefined) {
      options.claudeCodeEffortLevel = resolved.options.claudeCodeEffortLevel;
    }
    if (resolved.options.reasoningEffort !== undefined) {
      options.reasoningEffort = resolved.options.reasoningEffort;
    }
  } else if (args.adapter === 'codex-cli' && modelReasoningEffortFromAgent !== undefined) {
    options.modelReasoningEffort = modelReasoningEffortFromAgent;
  } else if (
    args.adapter !== 'codex-cli' &&
    args.adapter !== 'grok-build' &&
    claudeCodeEffortLevelFromAgent !== undefined
  ) {
    options.claudeCodeEffortLevel = claudeCodeEffortLevelFromAgent;
  } else if (args.adapter === 'grok-build' && grokReasoningEffortFromAgent !== undefined) {
    options.reasoningEffort = grokReasoningEffortFromAgent;
  }

  return { ok: true, options };
}
