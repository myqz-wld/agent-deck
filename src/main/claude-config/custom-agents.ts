import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getBundledAssetContent, type BundledAdapter } from '@main/bundled-assets';
import { settingsStore } from '@main/store/settings-store';
import { parseFrontmatter } from '@main/utils/frontmatter';

const CLAUDE_AGENT_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const USER_CLAUDE_AGENTS_DIR = join(homedir(), '.claude', 'agents');
const FRONTMATTER_BLOCK_REGEX = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/;
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const REVIEWER_CLAUDE_REQUIRED_MCP_TOOLS = [
  'mcp__agent-deck__send_message',
  'mcp__agent-deck__list_sessions',
] as const;

export type ClaudeCustomAgentEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export type ClaudeCustomAgentScope = 'bundled' | 'project' | 'user';

export interface ClaudeCustomAgentContent {
  name: string;
  source: ClaudeCustomAgentScope;
  sourcePath?: string;
  definition: AgentDefinition;
  model?: string;
  effortLevel?: ClaudeCustomAgentEffortLevel;
}

export function resolveClaudeAgentContent(
  agentName: string,
  cwd: string,
  adapter: BundledAdapter = 'claude-code',
): { ok: true; agent: ClaudeCustomAgentContent } | { ok: false; reason: string } {
  if (!CLAUDE_AGENT_NAME_RE.test(agentName)) {
    return { ok: false, reason: `invalid Claude agent name: ${agentName}` };
  }

  let bundledReason = 'bundled Agent Deck Claude agents disabled by settings.injectAgentDeckClaudeAgents=false';
  if (settingsStore.get('injectAgentDeckClaudeAgents') !== false) {
    const bundled = getBundledAssetContent('agent', agentName, adapter);
    if (bundled.ok) {
      return buildClaudeAgent(agentName, 'bundled', bundled.content);
    }
    bundledReason = bundled.reason;
  }

  for (const projectDir of getProjectClaudeAgentDirs(cwd)) {
    const path = join(projectDir, `${agentName}.md`);
    if (!safeIsFile(path)) continue;
    return buildClaudeAgent(agentName, 'project', readFileSync(path, 'utf8'), path);
  }

  const userPath = join(USER_CLAUDE_AGENTS_DIR, `${agentName}.md`);
  if (safeIsFile(userPath)) {
    return buildClaudeAgent(agentName, 'user', readFileSync(userPath, 'utf8'), userPath);
  }

  return {
    ok: false,
    reason:
      `${bundledReason}; not found in project .claude/agents directories or ${USER_CLAUDE_AGENTS_DIR}`,
  };
}

function buildClaudeAgent(
  agentName: string,
  source: ClaudeCustomAgentScope,
  content: string,
  sourcePath?: string,
): { ok: true; agent: ClaudeCustomAgentContent } | { ok: false; reason: string } {
  const fm = parseFrontmatter(content);
  const rawEffort = fm.effort?.trim();
  if (rawEffort && !isClaudeEffortLevel(rawEffort)) {
    return {
      ok: false,
      reason:
        `Claude agent ${sourcePath ?? agentName} has invalid effort "${rawEffort}" ` +
        `(expected one of: ${CLAUDE_EFFORT_LEVELS.join(', ')})`,
    };
  }
  const effortLevel = rawEffort && isClaudeEffortLevel(rawEffort) ? rawEffort : undefined;
  const body = content.replace(FRONTMATTER_BLOCK_REGEX, '').trim();
  const tools = withReviewerClaudeMessagingTools(agentName, parseCsvList(fm.tools));
  const skills = parseCsvList(fm.skills);
  const model = fm.model?.trim() || undefined;
  const definition: AgentDefinition = {
    description: fm.description?.trim() || agentName,
    prompt: body,
    ...(tools.length > 0 ? { tools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(model ? { model } : {}),
    ...(effortLevel ? { effort: effortLevel } : {}),
  };
  return {
    ok: true,
    agent: {
      name: agentName,
      source,
      ...(sourcePath ? { sourcePath } : {}),
      definition,
      ...(model ? { model } : {}),
      ...(effortLevel ? { effortLevel } : {}),
    },
  };
}

function isClaudeEffortLevel(value: string): value is ClaudeCustomAgentEffortLevel {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

function parseCsvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function withReviewerClaudeMessagingTools(agentName: string, tools: string[]): string[] {
  if (agentName !== 'reviewer-claude' || tools.length === 0) return tools;
  const out = [...tools];
  for (const requiredTool of REVIEWER_CLAUDE_REQUIRED_MCP_TOOLS) {
    if (!out.includes(requiredTool)) out.push(requiredTool);
  }
  return out;
}

function getProjectClaudeAgentDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  let current = cwd;
  while (true) {
    const candidate = join(current, '.claude', 'agents');
    if (!seen.has(candidate) && existsSync(candidate)) {
      dirs.push(candidate);
      seen.add(candidate);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
