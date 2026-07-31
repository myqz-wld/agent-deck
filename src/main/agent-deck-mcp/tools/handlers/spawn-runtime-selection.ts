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
  gateway?: string;
  profile?: string;
  model?: string;
  modelReasoningEffort?: SpawnCodexReasoningEffort;
  claudeCodeEffortLevel?: SpawnClaudeCodeEffortLevel;
  grokReasoningEffort?: SpawnGrokReasoningEffort;
}

type SpawnRuntimeSelectionResult =
  | {
      ok: true;
      inherit: boolean;
      gateway?: string;
      profile?: string;
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
        (args.adapter === 'codex-cli' ? args.profile : args.gateway) ??
        (args.adapter === 'codex-cli' ? agent.profile : agent.gateway) ??
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
          ? 'Remove gateway/profile and select a Grok model alias instead.'
          : args.adapter === 'codex-cli'
            ? 'Use a valid Codex config profile id, or omit profile.'
            : 'Use a valid Claude Gateway profile id, or omit gateway.',
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
    gateway: args.adapter === 'claude-code' ? inherited.provider ?? undefined : undefined,
    profile: args.adapter === 'codex-cli' ? inherited.provider ?? undefined : undefined,
    modelOptions: modelOptions.options,
  };
}
