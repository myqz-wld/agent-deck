import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getBundledAssetContent, type BundledAdapter } from '@main/bundled-assets';
import { parseFrontmatter } from '@main/utils/frontmatter';

const CLAUDE_AGENT_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const USER_CLAUDE_AGENTS_DIR = join(homedir(), '.claude', 'agents');
const FRONTMATTER_BLOCK_REGEX = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/;

export type ClaudeCustomAgentScope = 'bundled' | 'project' | 'user';

export interface ClaudeCustomAgentContent {
  name: string;
  source: ClaudeCustomAgentScope;
  sourcePath?: string;
  definition: AgentDefinition;
  model?: string;
}

export function resolveClaudeAgentContent(
  agentName: string,
  cwd: string,
  adapter: BundledAdapter = 'claude-code',
): { ok: true; agent: ClaudeCustomAgentContent } | { ok: false; reason: string } {
  if (!CLAUDE_AGENT_NAME_RE.test(agentName)) {
    return { ok: false, reason: `invalid Claude agent name: ${agentName}` };
  }

  const bundled = getBundledAssetContent('agent', agentName, adapter);
  if (bundled.ok) {
    return {
      ok: true,
      agent: {
        name: agentName,
        source: 'bundled',
        definition: buildClaudeAgentDefinition(agentName, bundled.content),
        model: extractModel(bundled.content),
      },
    };
  }

  for (const projectDir of getProjectClaudeAgentDirs(cwd)) {
    const path = join(projectDir, `${agentName}.md`);
    if (!safeIsFile(path)) continue;
    const content = readFileSync(path, 'utf8');
    return {
      ok: true,
      agent: {
        name: agentName,
        source: 'project',
        sourcePath: path,
        definition: buildClaudeAgentDefinition(agentName, content),
        model: extractModel(content),
      },
    };
  }

  const userPath = join(USER_CLAUDE_AGENTS_DIR, `${agentName}.md`);
  if (safeIsFile(userPath)) {
    const content = readFileSync(userPath, 'utf8');
    return {
      ok: true,
      agent: {
        name: agentName,
        source: 'user',
        sourcePath: userPath,
        definition: buildClaudeAgentDefinition(agentName, content),
        model: extractModel(content),
      },
    };
  }

  return {
    ok: false,
    reason:
      `${bundled.reason}; not found in project .claude/agents directories or ${USER_CLAUDE_AGENTS_DIR}`,
  };
}

function buildClaudeAgentDefinition(agentName: string, content: string): AgentDefinition {
  const fm = parseFrontmatter(content);
  const body = content.replace(FRONTMATTER_BLOCK_REGEX, '').trim();
  const tools = parseCsvList(fm.tools);
  const skills = parseCsvList(fm.skills);
  return {
    description: fm.description?.trim() || agentName,
    prompt: body,
    ...(tools.length > 0 ? { tools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(fm.model?.trim() ? { model: fm.model.trim() } : {}),
  };
}

function extractModel(content: string): string | undefined {
  const model = parseFrontmatter(content).model?.trim();
  return model || undefined;
}

function parseCsvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
