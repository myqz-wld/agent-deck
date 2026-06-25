import type {
  SpawnSessionArgs,
  SpawnSessionModelValue,
  SpawnSessionThinkingValue,
} from '../schemas';

export type SpawnCodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type SpawnClaudeCodeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SpawnModelOptions {
  model?: string;
  modelReasoningEffort?: SpawnCodexReasoningEffort;
  claudeCodeEffortLevel?: SpawnClaudeCodeEffortLevel;
}

export type SpawnModelOptionsResult =
  | { ok: true; options: SpawnModelOptions }
  | { ok: false; error: string; hint: string };

const THINKING_VALUES_BY_ADAPTER = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex-cli': ['minimal', 'low', 'medium', 'high', 'xhigh'],
  'deepseek-claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
} as const satisfies Record<SpawnSessionArgs['adapter'], readonly SpawnSessionThinkingValue[]>;

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
  const allowed = THINKING_VALUES_BY_ADAPTER[adapter];
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
  return { ok: true, options: { claudeCodeEffortLevel: thinking as SpawnClaudeCodeEffortLevel } };
}

export function resolveSpawnModelOptions(
  args: SpawnSessionArgs,
  modelFromFrontmatter: string | undefined,
  modelReasoningEffortFromAgent?: SpawnCodexReasoningEffort,
  claudeCodeEffortLevelFromAgent?: SpawnClaudeCodeEffortLevel,
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
  } else if (args.adapter === 'codex-cli' && modelReasoningEffortFromAgent !== undefined) {
    options.modelReasoningEffort = modelReasoningEffortFromAgent;
  } else if (args.adapter !== 'codex-cli' && claudeCodeEffortLevelFromAgent !== undefined) {
    options.claudeCodeEffortLevel = claudeCodeEffortLevelFromAgent;
  }

  return { ok: true, options };
}
