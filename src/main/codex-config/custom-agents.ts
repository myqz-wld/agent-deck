/**
 * Codex custom agent loader for `spawn_session(agentName=...)`.
 *
 * Official Codex custom agents are TOML files whose `name` field is the source of
 * truth. Agent Deck resolves them from native roots plus Agent Deck's Plugin Agent extension:
 *   1. bundled Agent Deck Codex agents
 *   2. project-scoped `.codex/agents/*.toml`, closest cwd first
 *   3. project Plugin `agents/*.toml`
 *   4. user-scoped `${CODEX_HOME:-~/.codex}/agents/*.toml`
 *   5. user Plugin `agents/*.toml`
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getCodexAgentDeckPluginPath } from '@main/adapters/codex-cli/codex-config-paths';
import { settingsStore } from '@main/store/settings-store';
import log from '@main/utils/logger';
import {
  parseCodexAgentToml,
  type CodexAgentTomlObject,
} from '@shared/codex-agent-toml';
import {
  isCodexThinkingLevel,
  type CodexThinkingLevel,
} from '@shared/session-metadata';
import {
  getCodexHome,
  resolveCodexProjectPluginAgentContent,
  resolveCodexUserPluginAgentContent,
  type CodexPluginAgentContent,
} from './plugin-assets';

const logger = log.scope('codex-custom-agents');

const CODEX_DIRECT_AGENT_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const CODEX_AGENT_NAME_RE = /^[a-zA-Z0-9._-]{1,128}(?::[a-zA-Z0-9._-]{1,128})?$/;
const CODEX_SANDBOX_MODES = ['workspace-write', 'read-only', 'danger-full-access'] as const;

export type CodexCustomAgentReasoningEffort = CodexThinkingLevel;
export type CodexCustomAgentSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type CodexCustomAgentScope = 'bundled' | 'project' | 'user' | 'plugin';

export interface CodexCustomAgentContent {
  name: string;
  source: CodexCustomAgentScope;
  sourcePath: string;
  pluginDir?: string;
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
  runtimeName?: string;
  pluginDir?: string;
  agent: ReturnType<typeof parseCodexAgentToml>;
}

export function resolveCodexAgentContent(
  agentName: string,
  cwd: string,
): { ok: true; agent: CodexCustomAgentContent } | { ok: false; reason: string } {
  if (!CODEX_AGENT_NAME_RE.test(agentName)) {
    return { ok: false, reason: `invalid Codex agent name: ${agentName}` };
  }

  const includeBundled = settingsStore.get('injectAgentDeckCodexAgents') !== false;
  if (includeBundled && CODEX_DIRECT_AGENT_NAME_RE.test(agentName)) {
    const bundled = findCodexAgentInDirs(agentName, 'bundled', [getBundledCodexAgentsDir()]);
    if (bundled.ok || !bundled.reason.startsWith('not found')) return bundled;
  }

  const projectDirs = getProjectCodexAgentDirs(cwd);
  if (CODEX_DIRECT_AGENT_NAME_RE.test(agentName)) {
    for (const projectDir of projectDirs) {
      const project = findCodexAgentInDirs(agentName, 'project', [projectDir]);
      if (project.ok || !project.reason.startsWith('not found')) return project;
    }
  }

  const projectPlugin = resolveCodexProjectPluginAgentContent(agentName, cwd);
  if (projectPlugin.ok) return buildPluginContent(projectPlugin.agent);
  if (!projectPlugin.reason.startsWith('not found')) return projectPlugin;

  const userAgentsDir = getUserCodexAgentsDir();
  if (CODEX_DIRECT_AGENT_NAME_RE.test(agentName)) {
    const user = findCodexAgentInDirs(agentName, 'user', [userAgentsDir]);
    if (user.ok || !user.reason.startsWith('not found')) return user;
  }

  const userPlugin = resolveCodexUserPluginAgentContent(agentName);
  if (userPlugin.ok) return buildPluginContent(userPlugin.agent);
  if (!userPlugin.reason.startsWith('not found')) return userPlugin;

  return {
    ok: false,
    reason:
      `not found: Codex agent "${agentName}". Checked ` +
      `${includeBundled ? 'bundled Agent Deck agents, ' : ''}` +
      `${projectDirs.length > 0 ? projectDirs.join(', ') : 'no project .codex/agents directories'}, ` +
      `project/user Plugins, and ${userAgentsDir}.`,
  };
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
  const { source, sourcePath, runtimeName, pluginDir, agent } = parsed;
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
    !isCodexThinkingLevel(modelReasoningEffort)
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
      name: runtimeName ?? agent.name,
      source,
      sourcePath,
      ...(pluginDir ? { pluginDir } : {}),
      description: agent.description,
      developerInstructions: agent.developerInstructions,
      model: agent.model,
      modelReasoningEffort: isCodexThinkingLevel(modelReasoningEffort)
        ? modelReasoningEffort
        : undefined,
      sandboxMode: sandboxMode ? (sandboxMode as CodexCustomAgentSandboxMode) : undefined,
      config: agent.config,
    },
  };
}

function buildPluginContent(
  agent: CodexPluginAgentContent,
): { ok: true; agent: CodexCustomAgentContent } | { ok: false; reason: string } {
  return buildContent({
    source: 'plugin',
    sourcePath: agent.sourcePath,
    runtimeName: agent.runtimeName,
    pluginDir: agent.pluginDir,
    agent: agent.parsed,
  });
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

function getUserCodexAgentsDir(): string {
  return join(getCodexHome(), 'agents');
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
