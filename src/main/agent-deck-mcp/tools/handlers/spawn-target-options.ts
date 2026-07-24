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
  effectiveSessionMode?: SpawnSessionArgs['sessionMode'];
  effectiveCodexSandbox: SpawnSessionArgs['codexSandbox'];
  effectiveClaudeCodeSandbox: SpawnSessionArgs['claudeCodeSandbox'];
  effectiveExtraAllowWrite: readonly string[] | undefined;
  provider: string | undefined;
  modelOptions: SpawnModelOptions;
  developerInstructions: string | undefined;
  codexConfigOverrides: CodexConfigObject | undefined;
  claudeAgentName: string | undefined;
  claudeAgents: Record<string, AgentDefinition> | undefined;
  grokAgentName?: string;
  /** Main-only same-adapter inheritance for an internal Codex review fork. */
  codexRuntimeAccess?: {
    networkAccessEnabled?: boolean;
    additionalDirectories?: readonly string[];
  };
}

/** Build the adapter-discriminated target options exactly once for fresh and fork dispatch. */
export function buildSpawnTargetOptions(input: SpawnTargetOptionsInput): CreateSessionOptions {
  const { args } = input;
  const claudeAgents = alignActiveClaudeAgentRuntime(
    input.claudeAgentName,
    input.claudeAgents,
    input.modelOptions,
  );
  const target = buildCreateSessionOptions(args.adapter, {
    cwd: args.cwd,
    prompt: input.prompt,
    ...omitUndefined({
      permissionMode: input.effectivePermissionMode,
      sessionMode: input.effectiveSessionMode,
      codexSandbox: input.effectiveCodexSandbox,
      claudeCodeSandbox: input.effectiveClaudeCodeSandbox,
      teamName: args.teamName,
      provider: input.provider,
      model: input.modelOptions.model,
      modelReasoningEffort: input.modelOptions.modelReasoningEffort,
      claudeCodeEffortLevel: input.modelOptions.claudeCodeEffortLevel,
      reasoningEffort: input.modelOptions.reasoningEffort,
      developerInstructions: input.developerInstructions,
      codexConfigOverrides: input.codexConfigOverrides,
      claudeAgentName: input.claudeAgentName,
      claudeAgents,
      grokAgentName: input.grokAgentName,
      agentName: args.agentName,
      awaitCanonicalId: true,
    }),
    ...(input.effectiveExtraAllowWrite !== undefined && input.effectiveExtraAllowWrite.length > 0
      ? { extraAllowWrite: input.effectiveExtraAllowWrite }
      : {}),
  });
  if (target.agentId === 'codex-cli' && input.codexRuntimeAccess) {
    if (input.codexRuntimeAccess.networkAccessEnabled !== undefined) {
      target.networkAccessEnabled = input.codexRuntimeAccess.networkAccessEnabled;
    }
    if (input.codexRuntimeAccess.additionalDirectories?.length) {
      target.additionalDirectories = [...input.codexRuntimeAccess.additionalDirectories];
    }
  }
  return target;
}

function alignActiveClaudeAgentRuntime(
  agentName: string | undefined,
  agents: Record<string, AgentDefinition> | undefined,
  modelOptions: SpawnModelOptions,
): Record<string, AgentDefinition> | undefined {
  if (!agentName || !agents?.[agentName]) return agents;
  const definition = agents[agentName];
  return {
    ...agents,
    [agentName]: {
      ...definition,
      ...(modelOptions.model !== undefined ? { model: modelOptions.model } : {}),
      ...(modelOptions.claudeCodeEffortLevel !== undefined
        ? { effort: modelOptions.claudeCodeEffortLevel }
        : {}),
    },
  };
}

/** Replace the provisional prompt after the normal team/reply context is assembled. */
export function setSpawnTargetPrompt(target: CreateSessionOptions, prompt: string): void {
  target.prompt = prompt;
}

/** Attach trusted main-only registration metadata after caller ownership is known. */
export function setSpawnTargetInitialRegistration(
  target: CreateSessionOptions,
  registration: NonNullable<CreateSessionOptions['initialSessionRegistration']>,
): void {
  target.initialSessionRegistration = registration;
}
