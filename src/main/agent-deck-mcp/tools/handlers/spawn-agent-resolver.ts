import { resolveClaudeAgentContent } from '@main/claude-config/custom-agents';
import {
  resolveCodexAgentContent,
  type CodexCustomAgentContent,
} from '@main/codex-config/custom-agents';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { getBundledAssetContent } from '@main/bundled-assets';
import { getBundledAgentRuntimeOverride } from '@main/bundled-agent-runtime-overrides';
import { resolveGrokUserAgentContent } from '@main/adapters/grok-build/custom-assets';
import { settingsStore } from '@main/store/settings-store';
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
      gateway?: string;
      profile?: string;
      developerInstructions?: string;
      model?: string;
      modelReasoningEffort?: SpawnCodexReasoningEffort;
      codexSandbox?: SpawnSessionArgs['codexSandbox'];
      codexConfigOverrides?: CodexConfigObject;
      claudeAgentName?: string;
      claudeAgents?: Record<string, AgentDefinition>;
      claudePluginDir?: string;
      claudeCodeEffortLevel?: SpawnClaudeCodeEffortLevel;
      grokAgentName?: string;
      grokAgentSource?: 'bundled' | 'project' | 'user' | 'plugin';
      grokPluginDir?: string;
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
        : resolveGrokSpawnAgent(agentName, cwd);
  if (agent.ok) return agent;

  return {
    ok: false,
    error: `agent not found for agentName="${agentName}"`,
    hint:
      `${agent.hint}. ` +
      (assetAdapter === 'grok-build'
        ? 'Grok Build agentName resolves bundled, project, user, and plugin agents discovered by Grok. Omit agentName for a generic teammate and use displayName for labels.'
        : 'Available sources are bundled Agent Deck agents, project direct/Plugin agents, and user direct/Plugin agents. Plugin-qualified names use plugin-name:agent-name. Omit agentName for generic teammates and use displayName for labels.'),
  };
}

function resolveGrokSpawnAgent(agentName: string, cwd: string): ResolvedSpawnAgent {
  const bundled =
    settingsStore.get('injectAgentDeckGrokAgents') === false
      ? {
          ok: false as const,
          reason: 'bundled Agent Deck Grok agents disabled by settings.injectAgentDeckGrokAgents=false',
        }
      : getBundledAssetContent('agent', agentName, 'grok-build');
  const custom = bundled.ok ? null : resolveGrokUserAgentContent(agentName, cwd);
  const source = bundled.ok
    ? {
        source: 'bundled' as const,
        content: bundled.content,
        frontmatter: parseFrontmatter(bundled.content),
      }
    : custom?.ok
      ? custom.agent
      : null;
  if (!source) {
    const lookupReason =
      custom?.ok === false
        ? custom.reason
        : bundled.ok
          ? 'Grok agent lookup failed'
          : bundled.reason;
    return {
      ok: false,
      error: lookupReason,
      hint: `Grok bundled/project/user/plugin agent lookup failed: ${lookupReason}`,
    };
  }
  const rawThinking = (source.frontmatter.effort ?? source.frontmatter.model_reasoning_effort)?.trim();
  if (rawThinking && !isGrokThinkingLevel(rawThinking)) {
    return {
      ok: false,
      error: `invalid Grok effort "${rawThinking}"`,
      hint: 'Use one of: low, medium, high, xhigh.',
    };
  }
  const override =
    source.source === 'bundled'
      ? getBundledAgentRuntimeOverride('grok-build', agentName)
      : {};
  return {
    ok: true,
    grokAgentName: source.source === 'bundled' ? agentName : source.name,
    grokAgentSource: source.source,
    ...(source.source !== 'bundled' && source.pluginDir
      ? { grokPluginDir: source.pluginDir }
      : {}),
    model: (override.model ?? source.frontmatter.model?.trim()) || undefined,
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
  const gateway = override.provider ?? resolved.agent.gateway;
  const effort =
    (override.thinking as SpawnClaudeCodeEffortLevel | undefined) ??
    resolved.agent.effortLevel;
  return {
    ok: true,
    gateway,
    model,
    claudeAgentName: resolved.agent.name,
    ...(resolved.agent.source === 'plugin'
      ? { claudePluginDir: resolved.agent.pluginDir }
      : {
          claudeAgents: {
            [resolved.agent.name]: {
              ...resolved.agent.definition,
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
            },
          },
        }),
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
  // A bundled app-owned override may select a native process profile. Custom-agent
  // `model_provider` remains part of its config layer and is not reinterpreted as a profile name.
  const profile = override.provider;
  const effort =
    (override.thinking as SpawnCodexReasoningEffort | undefined) ??
    resolved.agent.modelReasoningEffort;
  const config: CodexConfigObject = {
    ...(resolved.agent.config as CodexConfigObject),
  };
  return {
    ok: true,
    profile,
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
