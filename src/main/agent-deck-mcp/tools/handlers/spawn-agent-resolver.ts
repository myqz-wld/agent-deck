import { resolveClaudeAgentContent } from '@main/claude-config/custom-agents';
import {
  resolveCodexAgentContent,
  type CodexCustomAgentContent,
} from '@main/codex-config/custom-agents';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { SpawnSessionArgs } from '../schemas';
import type {
  SpawnClaudeCodeEffortLevel,
  SpawnCodexReasoningEffort,
} from './spawn-model-options';

type SpawnAssetAdapter = 'claude-code' | 'codex-cli';

export type ResolvedSpawnAgent =
  | {
      ok: true;
      developerInstructions?: string;
      model?: string;
      modelReasoningEffort?: SpawnCodexReasoningEffort;
      codexSandbox?: SpawnSessionArgs['codexSandbox'];
      codexConfigOverrides?: CodexConfigObject;
      claudeAgentName?: string;
      claudeAgents?: Record<string, AgentDefinition>;
      claudeCodeEffortLevel?: SpawnClaudeCodeEffortLevel;
    }
  | { ok: false; error: string; hint: string };

function assetAdapterForSpawn(
  adapter: SpawnSessionArgs['adapter'],
): SpawnAssetAdapter | null {
  if (adapter === 'deepseek-claude-code') return 'claude-code';
  if (adapter === 'claude-code' || adapter === 'codex-cli') return adapter;
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
      hint: 'Drop agentName and pass full prompt directly, or use a supported adapter: claude-code, deepseek-claude-code, or codex-cli.',
    };
  }

  const agent =
    assetAdapter === 'claude-code'
      ? resolveClaudeSpawnAgent(agentName, cwd, assetAdapter)
      : resolveCodexSpawnAgent(agentName, cwd);
  if (agent.ok) return agent;

  return {
    ok: false,
    error: `agent not found for agentName="${agentName}"`,
    hint:
      `${agent.hint}. ` +
      'Available sources are bundled Agent Deck agents, project agents in .claude/agents or .codex/agents, and user agents in ~/.claude/agents or ~/.codex/agents. Omit agentName for generic teammates and use displayName for labels.',
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
  return {
    ok: true,
    model: resolved.agent.model,
    claudeAgentName: resolved.agent.name,
    claudeAgents: {
      [resolved.agent.name]: resolved.agent.definition,
    },
    claudeCodeEffortLevel: resolved.agent.effortLevel,
  };
}

function resolveCodexSpawnAgent(agentName: string, cwd: string): ResolvedSpawnAgent {
  const resolved = resolveCodexAgentContent(agentName, cwd);
  if (!resolved.ok) {
    return { ok: false, error: resolved.reason, hint: `Codex custom agent lookup failed: ${resolved.reason}` };
  }
  return {
    ok: true,
    developerInstructions: buildCodexCustomAgentInstructions(resolved.agent),
    model: resolved.agent.model,
    modelReasoningEffort: resolved.agent.modelReasoningEffort,
    codexSandbox: resolved.agent.sandboxMode,
    codexConfigOverrides: resolved.agent.config as CodexConfigObject,
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
