import { normalizeSessionModelOptions } from '@main/adapters/session-model-options';
import type { SessionRecord } from '@shared/types';

import type { SpawnSessionArgs } from '../schemas';
import {
  resolveSpawnModelOptions,
  type SpawnClaudeCodeEffortLevel,
  type SpawnCodexReasoningEffort,
  type SpawnGrokReasoningEffort,
  type SpawnModelOptions,
} from './spawn-model-options';

interface SpawnAgentRuntimeSelection {
  provider?: string;
  model?: string;
  modelReasoningEffort?: SpawnCodexReasoningEffort;
  claudeCodeEffortLevel?: SpawnClaudeCodeEffortLevel;
  grokReasoningEffort?: SpawnGrokReasoningEffort;
}

type SpawnRuntimeSelectionResult =
  | {
      ok: true;
      inherit: boolean;
      provider?: string;
      modelOptions: SpawnModelOptions;
    }
  | {
      ok: false;
      error: string;
      hint: string;
    };

export function resolveSpawnRuntimeSelection(input: {
  args: SpawnSessionArgs;
  agent: SpawnAgentRuntimeSelection;
  leadRecord: SessionRecord | null;
}): SpawnRuntimeSelectionResult {
  const { args, agent, leadRecord } = input;
  const inherit = leadRecord?.agentId === args.adapter;
  let inherited: ReturnType<typeof normalizeSessionModelOptions>;
  try {
    inherited = normalizeSessionModelOptions(args.adapter, {
      provider:
        args.provider ??
        agent.provider ??
        (inherit ? leadRecord?.runtimeProvider ?? undefined : undefined),
      model: agent.model ?? (inherit ? leadRecord?.model ?? undefined : undefined),
      thinking: inherit ? leadRecord?.thinking ?? undefined : undefined,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hint:
        args.adapter === 'grok-build'
          ? 'Remove provider and select a Grok model alias instead.'
          : 'Use a valid Claude Gateway profile id or Codex model_provider id, or omit provider.',
    };
  }

  const modelOptions = resolveSpawnModelOptions(
    args,
    inherited.model ?? undefined,
    agent.modelReasoningEffort ??
      (args.adapter === 'codex-cli'
        ? (inherited.thinking as SpawnCodexReasoningEffort | undefined)
        : undefined),
    agent.claudeCodeEffortLevel ??
      (args.adapter === 'claude-code'
        ? (inherited.thinking as SpawnClaudeCodeEffortLevel | undefined)
        : undefined),
    agent.grokReasoningEffort ??
      (args.adapter === 'grok-build'
        ? (inherited.thinking as SpawnGrokReasoningEffort | undefined)
        : undefined),
  );
  if (!modelOptions.ok) return modelOptions;

  return {
    ok: true,
    inherit,
    provider: inherited.provider ?? undefined,
    modelOptions: modelOptions.options,
  };
}
