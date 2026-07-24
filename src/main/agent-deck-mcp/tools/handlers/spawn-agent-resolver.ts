import { resolveClaudeAgentContent } from '@main/claude-config/custom-agents';
import {
  resolveCodexAgentContent,
  type CodexCustomAgentContent,
} from '@main/codex-config/custom-agents';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { getBundledAssetContent } from '@main/bundled-assets';
import { getBundledAgentRuntimeOverride } from '@main/bundled-agent-runtime-overrides';
import { parseFrontmatter } from '@main/utils/frontmatter';
import { isGrokThinkingLevel } from '@shared/session-metadata';
import type { SpawnSessionArgs } from '../schemas';
import type {
  SpawnClaudeCodeEffortLevel,
  SpawnCodexReasoningEffort,
  SpawnGrokReasoningEffort,
} from './spawn-model-options';

type SpawnAssetAdapter = 'claude-code' | 'codex-cli' | 'grok-build';

export type ResolvedSpawnAgent =
  | {
      ok: true;
      provider?: string;
      developerInstructions?: string;
      model?: string;
      modelReasoningEffort?: SpawnCodexReasoningEffort;
      codexSandbox?: SpawnSessionArgs['codexSandbox'];
      codexConfigOverrides?: CodexConfigObject;
      claudeAgentName?: string;
      claudeAgents?: Record<string, AgentDefinition>;
      claudeCodeEffortLevel?: SpawnClaudeCodeEffortLevel;
      grokAgentName?: string;
      grokReasoningEffort?: SpawnGrokReasoningEffort;
    }
  | { ok: false; error: string; hint: string };

function assetAdapterForSpawn(
  adapter: SpawnSessionArgs['adapter'],
): SpawnAssetAdapter | null {
  if (
    adapter === 'claude-code' ||
    adapter === 'codex-cli' ||
    adapter === 'grok-build'
  ) {
    return adapter;
  }
  return null;
}

export function resolveSpawnAgent(
  agentName: string,
  adapter: SpawnSessionArgs['adapter'],
  cwd: string,
): ResolvedSpawnAgent {
  const assetAdapter = assetAdapterForSpawn(adapter);
  if (!assetAdapter) {
    return {
      ok: false,
      error: `agentName not supported for adapter "${adapter}"`,
      hint: 'Drop agentName and pass full prompt directly, or use a supported adapter: claude-code, codex-cli, or grok-build.',
    };
  }

  const agent =
    assetAdapter === 'claude-code'
      ? resolveClaudeSpawnAgent(agentName, cwd, assetAdapter)
      : assetAdapter === 'codex-cli'
        ? resolveCodexSpawnAgent(agentName, cwd)
        : resolveGrokSpawnAgent(agentName);
  if (agent.ok) return agent;

  return {
    ok: false,
    error: `agent not found for agentName="${agentName}"`,
    hint:
      `${agent.hint}. ` +
      (assetAdapter === 'grok-build'
        ? 'Grok Build agentName currently resolves bundled Agent Deck plugin agents only. Omit agentName for a generic teammate and use displayName for labels.'
        : 'Available sources are bundled Agent Deck agents, project agents in .claude/agents or .codex/agents, and user agents in ~/.claude/agents or ~/.codex/agents. Omit agentName for generic teammates and use displayName for labels.'),
  };
}

function resolveGrokSpawnAgent(agentName: string): ResolvedSpawnAgent {
  const resolved = getBundledAssetContent('agent', agentName, 'grok-build');
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.reason,
      hint: `Grok bundled agent lookup failed: ${resolved.reason}`,
    };
  }
  const fm = parseFrontmatter(resolved.content);
  const rawThinking = fm.effort?.trim();
  if (rawThinking && !isGrokThinkingLevel(rawThinking)) {
    return {
      ok: false,
      error: `invalid Grok effort "${rawThinking}"`,
      hint: 'Use one of: low, medium, high.',
    };
  }
  const override = getBundledAgentRuntimeOverride('grok-build', agentName);
  return {
    ok: true,
    grokAgentName: agentName,
    model: (override.model ?? fm.model?.trim()) || undefined,
    grokReasoningEffort:
      (override.thinking as SpawnGrokReasoningEffort | undefined) ??
      (rawThinking as SpawnGrokReasoningEffort | undefined),
  };
}

function resolveClaudeSpawnAgent(
  agentName: string,
  cwd: string,
  adapter: 'claude-code',
): ResolvedSpawnAgent {
  const resolved = resolveClaudeAgentContent(agentName, cwd, adapter);
  if (!resolved.ok) {
    return { ok: false, error: resolved.reason, hint: `Claude agent lookup failed: ${resolved.reason}` };
  }
  const override =
    resolved.agent.source === 'bundled'
      ? getBundledAgentRuntimeOverride('claude-code', resolved.agent.name)
      : {};
  const model = override.model ?? resolved.agent.model;
  const provider = override.provider ?? resolved.agent.provider;
  const effort =
    (override.thinking as SpawnClaudeCodeEffortLevel | undefined) ??
    resolved.agent.effortLevel;
  return {
    ok: true,
    provider,
    model,
    claudeAgentName: resolved.agent.name,
    claudeAgents: {
      [resolved.agent.name]: {
        ...resolved.agent.definition,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      },
    },
    claudeCodeEffortLevel: effort,
  };
}

function resolveCodexSpawnAgent(agentName: string, cwd: string): ResolvedSpawnAgent {
  const resolved = resolveCodexAgentContent(agentName, cwd);
  if (!resolved.ok) {
    return { ok: false, error: resolved.reason, hint: `Codex custom agent lookup failed: ${resolved.reason}` };
  }
  const override =
    resolved.agent.source === 'bundled'
      ? getBundledAgentRuntimeOverride('codex-cli', resolved.agent.name)
      : {};
  const model = override.model ?? resolved.agent.model;
  const provider =
    override.provider ??
    (typeof resolved.agent.config.model_provider === 'string'
      ? resolved.agent.config.model_provider.trim() || undefined
      : undefined);
  const effort =
    (override.thinking as SpawnCodexReasoningEffort | undefined) ??
    resolved.agent.modelReasoningEffort;
  const config: CodexConfigObject = {
    ...(resolved.agent.config as CodexConfigObject),
  };
  return {
    ok: true,
    provider,
    developerInstructions: buildCodexCustomAgentInstructions(resolved.agent),
    model,
    modelReasoningEffort: effort,
    codexSandbox: resolved.agent.sandboxMode,
    codexConfigOverrides: config,
  };
}

function buildCodexCustomAgentInstructions(agent: CodexCustomAgentContent): string {
  return [
    `# Codex custom agent: ${agent.name}`,
    agent.description ? `Description: ${agent.description}` : undefined,
    agent.developerInstructions,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}
