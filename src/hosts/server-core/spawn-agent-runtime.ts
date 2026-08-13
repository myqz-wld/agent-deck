import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import type {
  NodeAssetAdapterId,
  NodeAssetDto,
  SessionConsoleCreateOptions,
} from '@contracts/index';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { parseFrontmatter } from '@main/utils/frontmatter';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
} from '@shared/session-metadata';

import type { ServerCoreAgentCreateOptions } from './session-create-options';

const FRONTMATTER_BLOCK = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/;
const CLAUDE_REVIEWER_TOOLS = [
  'mcp__agent-deck__send_message',
  'mcp__agent-deck__list_sessions',
] as const;

export interface ServerCoreBundledAgentAsset {
  readonly dto: NodeAssetDto;
  readonly content: string;
}

export interface ServerCoreBundledAgentLookupPort {
  resolveBundledAgent(
    adapterId: NodeAssetAdapterId,
    agentName: string,
  ): ServerCoreBundledAgentAsset | null;
}

export interface ServerCoreResolvedSpawnAgent {
  readonly defaults: Partial<SessionConsoleCreateOptions>;
  readonly create: ServerCoreAgentCreateOptions;
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function claudeTools(agentName: string, value: string | undefined): string[] {
  const tools = csv(value);
  if (agentName !== 'reviewer-claude' || tools.length === 0) return tools;
  for (const required of CLAUDE_REVIEWER_TOOLS) {
    if (!tools.includes(required)) tools.push(required);
  }
  return tools;
}

function defaults(asset: NodeAssetDto): Partial<SessionConsoleCreateOptions> {
  return {
    ...(asset.model ? { model: asset.model } : {}),
    ...(asset.thinking ? { thinking: asset.thinking } : {}),
    ...(asset.adapterId === 'claude-code' && asset.provider
      ? { provider: asset.provider }
      : {}),
    ...(asset.adapterId === 'codex-cli' && asset.runtimeOverride?.provider
      ? { provider: asset.runtimeOverride.provider }
      : {}),
  };
}

function resolveClaude(asset: ServerCoreBundledAgentAsset): ServerCoreResolvedSpawnAgent {
  const frontmatter = parseFrontmatter(asset.content);
  const rawThinking = asset.dto.thinking;
  if (rawThinking && !isClaudeThinkingLevel(rawThinking)) {
    throw new Error(`Bundled Claude Agent "${asset.dto.name}" has invalid thinking`);
  }
  const thinking = isClaudeThinkingLevel(rawThinking) ? rawThinking : undefined;
  const tools = claudeTools(asset.dto.name, frontmatter.tools);
  const skills = csv(frontmatter.skills);
  const definition: AgentDefinition = {
    description: frontmatter.description?.trim() || asset.dto.name,
    prompt: asset.content.replace(FRONTMATTER_BLOCK, '').trim(),
    ...(tools.length > 0 ? { tools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(asset.dto.model ? { model: asset.dto.model } : {}),
    ...(thinking ? { effort: thinking } : {}),
  };
  return {
    defaults: defaults(asset.dto),
    create: {
      adapterId: 'claude-code',
      claudeAgentName: asset.dto.name,
      claudeAgents: { [asset.dto.name]: definition },
    },
  };
}

function resolveCodex(asset: ServerCoreBundledAgentAsset): ServerCoreResolvedSpawnAgent {
  const parsed = parseCodexAgentToml(asset.content);
  if (!parsed.developerInstructions) {
    throw new Error(`Bundled Codex Agent "${asset.dto.name}" has no instructions`);
  }
  if (asset.dto.thinking && !isCodexThinkingLevel(asset.dto.thinking)) {
    throw new Error(`Bundled Codex Agent "${asset.dto.name}" has invalid thinking`);
  }
  const sandbox = parsed.sandboxMode;
  if (sandbox && !['workspace-write', 'read-only', 'danger-full-access'].includes(sandbox)) {
    throw new Error(`Bundled Codex Agent "${asset.dto.name}" has invalid sandbox`);
  }
  return {
    defaults: {
      ...defaults(asset.dto),
      ...(sandbox ? { codexSandbox: sandbox } : {}),
    },
    create: {
      adapterId: 'codex-cli',
      developerInstructions: [
        `# Codex custom agent: ${asset.dto.name}`,
        parsed.description ? `Description: ${parsed.description}` : undefined,
        parsed.developerInstructions,
      ].filter((part): part is string => Boolean(part?.trim())).join('\n\n'),
      codexConfigOverrides: { ...parsed.config } as CodexConfigObject,
    },
  };
}

function resolveGrok(asset: ServerCoreBundledAgentAsset): ServerCoreResolvedSpawnAgent {
  if (asset.dto.thinking && !isGrokThinkingLevel(asset.dto.thinking)) {
    throw new Error(`Bundled Grok Agent "${asset.dto.name}" has invalid thinking`);
  }
  return {
    defaults: defaults(asset.dto),
    create: {
      adapterId: 'grok-build',
      grokAgentName: asset.dto.name,
      grokAgentSource: 'bundled',
    },
  };
}

export function resolveServerCoreSpawnAgent(
  lookup: ServerCoreBundledAgentLookupPort | null,
  adapterId: NodeAssetAdapterId,
  agentName: string,
): ServerCoreResolvedSpawnAgent {
  const asset = lookup?.resolveBundledAgent(adapterId, agentName) ?? null;
  if (!asset) {
    throw new Error(
      `Built-in Agent "${agentName}" is unavailable for ${adapterId}; ` +
      'enable that provider\'s built-in Agents or omit agentName',
    );
  }
  if (adapterId === 'claude-code') return resolveClaude(asset);
  if (adapterId === 'codex-cli') return resolveCodex(asset);
  return resolveGrok(asset);
}

/** Keeps explicit spawn values authoritative over the selected Claude Agent defaults. */
export function alignServerCoreSpawnAgentRuntime(
  resolved: ServerCoreResolvedSpawnAgent,
  options: SessionConsoleCreateOptions,
): ServerCoreAgentCreateOptions {
  if (resolved.create.adapterId !== 'claude-code') return resolved.create;
  const name = resolved.create.claudeAgentName;
  const definition = resolved.create.claudeAgents[name];
  return {
    ...resolved.create,
    claudeAgents: {
      ...resolved.create.claudeAgents,
      [name]: {
        ...definition,
        ...(options.model ? { model: options.model } : {}),
        ...(options.thinking && isClaudeThinkingLevel(options.thinking)
          ? { effort: options.thinking }
          : {}),
      },
    },
  };
}
