import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import type { CreateSessionOptions } from '@main/adapters/types';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { omitUndefined } from '@main/utils/optional-fields';
import type { SpawnSessionArgs } from '../schemas';
import type { SpawnModelOptions } from './spawn-model-options';

export interface SpawnTargetOptionsInput {
  args: SpawnSessionArgs;
  prompt: string;
  effectivePermissionMode: SpawnSessionArgs['permissionMode'];
  effectiveCodexSandbox: SpawnSessionArgs['codexSandbox'];
  effectiveClaudeCodeSandbox: SpawnSessionArgs['claudeCodeSandbox'];
  effectiveExtraAllowWrite: readonly string[] | undefined;
  modelOptions: SpawnModelOptions;
  developerInstructions: string | undefined;
  codexConfigOverrides: CodexConfigObject | undefined;
  claudeAgentName: string | undefined;
  claudeAgents: Record<string, AgentDefinition> | undefined;
}

/** Build the adapter-discriminated target options exactly once for fresh and fork dispatch. */
export function buildSpawnTargetOptions(input: SpawnTargetOptionsInput): CreateSessionOptions {
  const { args } = input;
  return buildCreateSessionOptions(args.adapter, {
    cwd: args.cwd,
    prompt: input.prompt,
    ...omitUndefined({
      permissionMode: input.effectivePermissionMode,
      codexSandbox: input.effectiveCodexSandbox,
      claudeCodeSandbox: input.effectiveClaudeCodeSandbox,
      teamName: args.teamName,
      model: input.modelOptions.model,
      modelReasoningEffort: input.modelOptions.modelReasoningEffort,
      claudeCodeEffortLevel: input.modelOptions.claudeCodeEffortLevel,
      developerInstructions: input.developerInstructions,
      codexConfigOverrides: input.codexConfigOverrides,
      claudeAgentName: input.claudeAgentName,
      claudeAgents: input.claudeAgents,
      agentName: args.agentName,
      handOff: args.handOff,
      awaitCanonicalId: true,
    }),
    ...(input.effectiveExtraAllowWrite !== undefined && input.effectiveExtraAllowWrite.length > 0
      ? { extraAllowWrite: input.effectiveExtraAllowWrite }
      : {}),
  });
}

/** Replace the provisional prompt after the normal team/reply context is assembled. */
export function setSpawnTargetPrompt(target: CreateSessionOptions, prompt: string): void {
  target.prompt = prompt;
}
