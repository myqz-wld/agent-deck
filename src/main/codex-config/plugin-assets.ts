import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  discoverPluginRoots,
  normalizeExistingPath,
  safeIsDir,
  safeIsFile,
  type PluginRoot,
} from '@main/plugin-assets';
import log from '@main/utils/logger';
import {
  parseCodexAgentToml,
  type ParsedCodexAgentToml,
} from '@shared/codex-agent-toml';
import { parseFrontmatter } from '@main/utils/frontmatter';
import type { AssetMeta, UserAssetsSnapshot } from '@shared/types';
import { getCodexHome } from './codex-home';

export { getCodexHome } from './codex-home';

const logger = log.scope('codex-plugin-assets');
const CODEX_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CODEX_PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface CodexPluginAssetBase {
  kind: 'agent' | 'skill';
  name: string;
  runtimeName: string;
  path: string;
  pluginName: string;
  pluginDir: string;
}

interface CodexPluginAgentAsset extends CodexPluginAssetBase {
  kind: 'agent';
  parsed: ParsedCodexAgentToml;
}

interface CodexPluginSkillAsset extends CodexPluginAssetBase {
  kind: 'skill';
  frontmatter: Record<string, string>;
}

type CodexPluginAsset = CodexPluginAgentAsset | CodexPluginSkillAsset;

export interface CodexPluginAgentContent {
  name: string;
  runtimeName: string;
  sourcePath: string;
  pluginName: string;
  pluginDir: string;
  parsed: ParsedCodexAgentToml;
}

type AgentLookup =
  | { ok: true; agent: CodexPluginAgentContent }
  | { ok: false; reason: string };

export function listCodexPluginAssets(): UserAssetsSnapshot {
  const assets = getCodexUserPluginRoots().flatMap(scanCodexPluginAssets);
  return {
    agents: assets.filter((asset) => asset.kind === 'agent').map(toAssetMeta).sort(compareAssets),
    skills: assets.filter((asset) => asset.kind === 'skill').map(toAssetMeta).sort(compareAssets),
  };
}

export function resolveCodexProjectPluginAgentContent(
  agentName: string,
  cwd: string,
): AgentLookup {
  for (const pluginContainer of getProjectPluginContainers(cwd)) {
    const result = findPluginAgent(
      discoverCodexPluginRoots([pluginContainer]),
      agentName,
      `project plugins under ${pluginContainer}`,
    );
    if (result.ok || !result.reason.startsWith('not found')) return result;
  }
  return { ok: false, reason: 'not found in project Codex plugin directories' };
}

export function resolveCodexUserPluginAgentContent(agentName: string): AgentLookup {
  return findPluginAgent(getCodexUserPluginRoots(), agentName, 'user Codex plugins');
}

export function getCodexPluginAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  pathHint?: string,
): string | null {
  if (!CODEX_ASSET_NAME_RE.test(name)) return null;
  const assets = getCodexUserPluginRoots().flatMap(scanCodexPluginAssets);
  const normalizedHint = pathHint ? normalizeExistingPath(pathHint) : null;
  if (pathHint && !normalizedHint) return null;
  const match = assets.find((asset) =>
    asset.kind === kind &&
    asset.name === name &&
    (!normalizedHint || normalizeExistingPath(asset.path) === normalizedHint)
  );
  return match?.path ?? null;
}

function getCodexUserPluginRoots(): PluginRoot[] {
  const codexHome = getCodexHome();
  return discoverCodexPluginRoots([
    join(codexHome, 'plugins', 'cache'),
    join(codexHome, 'plugins'),
    join(homedir(), '.agents', 'plugins'),
  ]);
}

function getProjectPluginContainers(cwd: string): string[] {
  const containers: string[] = [];
  let current = resolve(cwd);
  while (true) {
    for (const candidate of [
      join(current, '.codex', 'plugins'),
      join(current, '.agents', 'plugins'),
    ]) {
      if (safeIsDir(candidate)) containers.push(candidate);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return containers;
}

function discoverCodexPluginRoots(searchPaths: string[]): PluginRoot[] {
  return discoverPluginRoots({
    searchPaths,
    manifestPaths: ['.codex-plugin/plugin.json'],
    maxDepth: 6,
  });
}

function scanCodexPluginAssets(plugin: PluginRoot): CodexPluginAsset[] {
  if (!CODEX_PLUGIN_NAME_RE.test(plugin.name)) return [];
  return [
    ...scanAgentDir(plugin),
    ...scanSkillDir(plugin),
  ];
}

function scanAgentDir(plugin: PluginRoot): CodexPluginAgentAsset[] {
  const dir = join(plugin.path, 'agents');
  if (!safeIsDir(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const assets: CodexPluginAgentAsset[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.toml')) continue;
    const path = join(dir, entry);
    if (!safeIsFile(path)) continue;
    try {
      const parsed = parseCodexAgentToml(readFileSync(path, 'utf8'));
      if (!parsed.name || !CODEX_ASSET_NAME_RE.test(parsed.name)) continue;
      assets.push({
        kind: 'agent',
        name: parsed.name,
        runtimeName: `${plugin.name}:${parsed.name}`,
        path,
        pluginName: plugin.name,
        pluginDir: plugin.path,
        parsed,
      });
    } catch (error) {
      logger.warn(`[codex-plugin-assets] skip ${path}`, error);
    }
  }
  return assets;
}

function scanSkillDir(plugin: PluginRoot): CodexPluginSkillAsset[] {
  const dir = join(plugin.path, 'skills');
  if (!safeIsDir(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const assets: CodexPluginSkillAsset[] = [];
  for (const entry of entries.sort()) {
    const path = join(dir, entry, 'SKILL.md');
    if (!safeIsFile(path)) continue;
    try {
      const frontmatter = parseFrontmatter(readFileSync(path, 'utf8'));
      const name = frontmatter.name?.trim() || entry;
      if (!CODEX_ASSET_NAME_RE.test(name)) continue;
      assets.push({
        kind: 'skill',
        name,
        runtimeName: `${plugin.name}:${name}`,
        path,
        pluginName: plugin.name,
        pluginDir: plugin.path,
        frontmatter,
      });
    } catch (error) {
      logger.warn(`[codex-plugin-assets] skip ${path}`, error);
    }
  }
  return assets;
}

function findPluginAgent(
  plugins: PluginRoot[],
  agentName: string,
  scope: string,
): AgentLookup {
  const matches = plugins
    .flatMap(scanCodexPluginAssets)
    .filter((asset): asset is CodexPluginAgentAsset =>
      asset.kind === 'agent' &&
      (agentName.includes(':') ? asset.runtimeName === agentName : asset.name === agentName)
    );
  if (matches.length === 0) return { ok: false, reason: `not found in ${scope}` };
  if (matches.length > 1) {
    return {
      ok: false,
      reason:
        `multiple Codex plugin agents match "${agentName}": ` +
        matches.map((asset) => asset.runtimeName).join(', '),
    };
  }
  const match = matches[0];
  return {
    ok: true,
    agent: {
      name: match.name,
      runtimeName: match.runtimeName,
      sourcePath: match.path,
      pluginName: match.pluginName,
      pluginDir: match.pluginDir,
      parsed: match.parsed,
    },
  };
}

function toAssetMeta(asset: CodexPluginAsset): AssetMeta {
  return {
    kind: asset.kind,
    source: 'user',
    adapter: 'codex-cli',
    origin: 'plugin',
    pluginName: asset.pluginName,
    runtimeName: asset.runtimeName,
    name: asset.name,
    qualifiedName: `plugin:${asset.pluginName}/${asset.name}`,
    description:
      asset.kind === 'agent'
        ? asset.parsed.description ?? ''
        : asset.frontmatter.description ?? '',
    ...(asset.kind === 'agent'
      ? {
          model: asset.parsed.model,
          thinking: asset.parsed.modelReasoningEffort,
        }
      : {}),
    absPath: asset.path,
  };
}

function compareAssets(a: AssetMeta, b: AssetMeta): number {
  return a.qualifiedName.localeCompare(b.qualifiedName);
}
