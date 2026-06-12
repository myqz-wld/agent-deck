/**
 * Codex custom agent loader for `spawn_session(agentName=...)`.
 *
 * Official Codex custom agents are TOML files whose `name` field is the source of
 * truth. Agent Deck resolves them from three native scopes:
 *   1. bundled Agent Deck Codex agents
 *   2. project-scoped `.codex/agents/*.toml`, closest cwd first
 *   3. user-scoped `~/.codex/agents/*.toml`
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getCodexAgentDeckPluginPath } from '@main/adapters/codex-cli/codex-config-paths';
import log from '@main/utils/logger';
import {
  parseCodexAgentToml,
  type CodexAgentTomlObject,
} from '@shared/codex-agent-toml';

const logger = log.scope('codex-custom-agents');

const USER_CODEX_AGENTS_DIR = join(homedir(), '.codex', 'agents');
const CODEX_AGENT_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const CODEX_SANDBOX_MODES = ['workspace-write', 'read-only', 'danger-full-access'] as const;

export type CodexCustomAgentReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export type CodexCustomAgentSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type CodexCustomAgentScope = 'bundled' | 'project' | 'user';

export interface CodexCustomAgentContent {
  name: string;
  source: CodexCustomAgentScope;
  sourcePath: string;
  description?: string;
  developerInstructions: string;
  model?: string;
  modelReasoningEffort?: CodexCustomAgentReasoningEffort;
  sandboxMode?: CodexCustomAgentSandboxMode;
  config: CodexAgentTomlObject;
}

interface ParsedCodexAgentFile {
  source: CodexCustomAgentScope;
  sourcePath: string;
  agent: ReturnType<typeof parseCodexAgentToml>;
}

export function resolveCodexAgentContent(
  agentName: string,
  cwd: string,
): { ok: true; agent: CodexCustomAgentContent } | { ok: false; reason: string } {
  if (!CODEX_AGENT_NAME_RE.test(agentName)) {
    return { ok: false, reason: `invalid Codex agent name: ${agentName}` };
  }

  const bundled = findCodexAgentInDirs(agentName, 'bundled', [getBundledCodexAgentsDir()]);
  if (bundled.ok || bundled.reason.startsWith('multiple')) return bundled;

  const projectDirs = getProjectCodexAgentDirs(cwd);
  for (const projectDir of projectDirs) {
    const project = findCodexAgentInDirs(agentName, 'project', [projectDir]);
    if (project.ok || project.reason.startsWith('multiple')) return project;
  }

  const user = findCodexAgentInDirs(agentName, 'user', [USER_CODEX_AGENTS_DIR]);
  if (user.ok || user.reason.startsWith('multiple')) return user;

  return {
    ok: false,
    reason:
      `not found: Codex agent "${agentName}". Checked bundled Agent Deck agents, ` +
      `${projectDirs.length > 0 ? projectDirs.join(', ') : 'no project .codex/agents directories'}, ` +
      `and ${USER_CODEX_AGENTS_DIR}.`,
  };
}

export function getUserCodexAgentContent(
  agentName: string,
): { ok: true; agent: CodexCustomAgentContent } | { ok: false; reason: string } {
  if (!CODEX_AGENT_NAME_RE.test(agentName)) {
    return { ok: false, reason: `invalid Codex agent name: ${agentName}` };
  }
  return findCodexAgentInDirs(agentName, 'user', [USER_CODEX_AGENTS_DIR]);
}

export function getBundledCodexAgentsDir(): string {
  return join(getCodexAgentDeckPluginPath(), 'agents');
}

function findCodexAgentInDirs(
  agentName: string,
  source: CodexCustomAgentScope,
  dirs: string[],
): { ok: true; agent: CodexCustomAgentContent } | { ok: false; reason: string } {
  const matches = dirs.flatMap((dir) => scanCodexAgentDir(dir, source))
    .filter((item) => item.agent.name === agentName);

  if (matches.length === 0) {
    return { ok: false, reason: `not found in ${dirs.join(', ')}` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `multiple Codex custom agents named "${agentName}": ${matches.map((m) => m.sourcePath).join(', ')}`,
    };
  }

  return buildContent(matches[0]);
}

function buildContent(
  parsed: ParsedCodexAgentFile,
): { ok: true; agent: CodexCustomAgentContent } | { ok: false; reason: string } {
  const { source, sourcePath, agent } = parsed;
  if (!agent.name) {
    return { ok: false, reason: `Codex custom agent ${sourcePath} is missing required name` };
  }
  if (!agent.developerInstructions) {
    return {
      ok: false,
      reason: `Codex custom agent ${sourcePath} is missing required developer_instructions`,
    };
  }

  const modelReasoningEffort = agent.modelReasoningEffort;
  if (
    modelReasoningEffort &&
    !CODEX_REASONING_EFFORTS.includes(modelReasoningEffort as CodexCustomAgentReasoningEffort)
  ) {
    return {
      ok: false,
      reason: `Codex custom agent ${sourcePath} has invalid model_reasoning_effort "${modelReasoningEffort}"`,
    };
  }

  const sandboxMode = agent.sandboxMode;
  if (sandboxMode && !CODEX_SANDBOX_MODES.includes(sandboxMode as CodexCustomAgentSandboxMode)) {
    return {
      ok: false,
      reason: `Codex custom agent ${sourcePath} has invalid sandbox_mode "${sandboxMode}"`,
    };
  }

  return {
    ok: true,
    agent: {
      name: agent.name,
      source,
      sourcePath,
      description: agent.description,
      developerInstructions: agent.developerInstructions,
      model: agent.model,
      modelReasoningEffort: modelReasoningEffort
        ? (modelReasoningEffort as CodexCustomAgentReasoningEffort)
        : undefined,
      sandboxMode: sandboxMode ? (sandboxMode as CodexCustomAgentSandboxMode) : undefined,
      config: agent.config,
    },
  };
}

function scanCodexAgentDir(dir: string, source: CodexCustomAgentScope): ParsedCodexAgentFile[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    logger.warn(`[codex-custom-agents] read failed: ${dir}`, err);
    return [];
  }

  const agents: ParsedCodexAgentFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.toml')) continue;
    const sourcePath = join(dir, entry);
    if (!safeIsFile(sourcePath)) continue;
    try {
      agents.push({
        source,
        sourcePath,
        agent: parseCodexAgentToml(readFileSync(sourcePath, 'utf8')),
      });
    } catch (err) {
      logger.warn(
        `[codex-custom-agents] skip ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return agents;
}

function getProjectCodexAgentDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  let current = cwd;
  while (true) {
    const candidate = join(current, '.codex', 'agents');
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
