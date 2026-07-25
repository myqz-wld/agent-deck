import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  discoverPluginRoots,
  normalizeExistingPath,
  safeIsDir,
  safeIsFile,
  type PluginRoot,
} from '@main/plugin-assets';
import { parseFrontmatter } from '@main/utils/frontmatter';
import log from '@main/utils/logger';
import type { AssetMeta, UserAssetsSnapshot } from '@shared/types';

const logger = log.scope('claude-plugin-assets');
const CLAUDE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLAUDE_PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface ClaudePluginAsset {
  kind: 'agent' | 'skill';
  name: string;
  runtimeName: string;
  path: string;
  pluginName: string;
  pluginDir: string;
  content: string;
  frontmatter: Record<string, string>;
}

export interface ClaudePluginAgentContent {
  name: string;
  runtimeName: string;
  sourcePath: string;
  pluginName: string;
  pluginDir: string;
  content: string;
}

type AgentLookup =
  | { ok: true; agent: ClaudePluginAgentContent }
  | { ok: false; reason: string };

export function listClaudePluginAssets(): UserAssetsSnapshot {
  const assets = getClaudeUserPluginRoots().flatMap(scanClaudePluginAssets);
  return {
    agents: assets.filter((asset) => asset.kind === 'agent').map(toAssetMeta).sort(compareAssets),
    skills: assets.filter((asset) => asset.kind === 'skill').map(toAssetMeta).sort(compareAssets),
  };
}

export function resolveClaudeProjectPluginAgentContent(
  agentName: string,
  cwd: string,
): AgentLookup {
  for (const pluginContainer of getProjectPluginContainers(cwd)) {
    const result = findPluginAgent(
      discoverClaudePluginRoots([pluginContainer]),
      agentName,
      `project plugins under ${pluginContainer}`,
    );
    if (result.ok || !result.reason.startsWith('not found')) return result;
  }
  return { ok: false, reason: 'not found in project .claude/plugins directories' };
}

export function resolveClaudeUserPluginAgentContent(agentName: string): AgentLookup {
  return findPluginAgent(getClaudeUserPluginRoots(), agentName, 'user Claude plugins');
}

export function getClaudePluginAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  pathHint?: string,
): string | null {
  if (!CLAUDE_ASSET_NAME_RE.test(name)) return null;
  const assets = getClaudeUserPluginRoots().flatMap(scanClaudePluginAssets);
  const normalizedHint = pathHint ? normalizeExistingPath(pathHint) : null;
  if (pathHint && !normalizedHint) return null;
  const match = assets.find((asset) =>
    asset.kind === kind &&
    asset.name === name &&
    (!normalizedHint || normalizeExistingPath(asset.path) === normalizedHint)
  );
  return match?.path ?? null;
}

export function getClaudeConfigRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), '.claude');
}

function getClaudeUserPluginRoots(): PluginRoot[] {
  const configRoot = getClaudeConfigRoot();
  const installed = readInstalledPluginPaths(join(configRoot, 'plugins', 'installed_plugins.json'));
  return discoverClaudePluginRoots(
    installed.length > 0 ? installed : [join(configRoot, 'plugins')],
  );
}

function getProjectPluginContainers(cwd: string): string[] {
  const containers: string[] = [];
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, '.claude', 'plugins');
    if (safeIsDir(candidate)) containers.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return containers;
}

function discoverClaudePluginRoots(searchPaths: string[]): PluginRoot[] {
  return discoverPluginRoots({
    searchPaths,
    manifestPaths: ['.claude-plugin/plugin.json', 'plugin.json'],
    maxDepth: 6,
  });
}

function readInstalledPluginPaths(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const found = new Set<string>();
    collectInstallPaths(parsed, found);
    return [...found];
  } catch (error) {
    logger.warn(`[claude-plugin-assets] cannot read installed plugins: ${path}`, error);
    return [];
  }
}

function collectInstallPaths(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectInstallPaths(item, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'installPath' && typeof child === 'string' && child.trim()) {
      found.add(resolve(child));
      continue;
    }
    collectInstallPaths(child, found);
  }
}

function scanClaudePluginAssets(plugin: PluginRoot): ClaudePluginAsset[] {
  if (!CLAUDE_PLUGIN_NAME_RE.test(plugin.name)) return [];
  return [
    ...scanAgentDir(plugin),
    ...scanSkillDir(plugin),
  ];
}

function scanAgentDir(plugin: PluginRoot): ClaudePluginAsset[] {
  const dir = join(plugin.path, 'agents');
  if (!safeIsDir(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const assets: ClaudePluginAsset[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const path = join(dir, entry);
    if (!safeIsFile(path)) continue;
    const asset = readMarkdownAsset('agent', plugin, path, basename(entry, '.md'));
    if (asset) assets.push(asset);
  }
  return assets;
}

function scanSkillDir(plugin: PluginRoot): ClaudePluginAsset[] {
  const dir = join(plugin.path, 'skills');
  if (!safeIsDir(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const assets: ClaudePluginAsset[] = [];
  for (const entry of entries.sort()) {
    const path = join(dir, entry, 'SKILL.md');
    if (!safeIsFile(path)) continue;
    const asset = readMarkdownAsset('skill', plugin, path, entry);
    if (asset) assets.push(asset);
  }
  return assets;
}

function readMarkdownAsset(
  kind: 'agent' | 'skill',
  plugin: PluginRoot,
  path: string,
  fallbackName: string,
): ClaudePluginAsset | null {
  try {
    const content = readFileSync(path, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const name = frontmatter.name?.trim() || fallbackName;
    if (!CLAUDE_ASSET_NAME_RE.test(name)) return null;
    return {
      kind,
      name,
      runtimeName: `${plugin.name}:${name}`,
      path,
      pluginName: plugin.name,
      pluginDir: plugin.path,
      content,
      frontmatter,
    };
  } catch (error) {
    logger.warn(`[claude-plugin-assets] skip ${path}`, error);
    return null;
  }
}

function findPluginAgent(
  plugins: PluginRoot[],
  agentName: string,
  scope: string,
): AgentLookup {
  const matches = plugins
    .flatMap(scanClaudePluginAssets)
    .filter((asset) =>
      asset.kind === 'agent' &&
      (agentName.includes(':') ? asset.runtimeName === agentName : asset.name === agentName)
    );
  if (matches.length === 0) return { ok: false, reason: `not found in ${scope}` };
  if (matches.length > 1) {
    return {
      ok: false,
      reason:
        `multiple Claude plugin agents match "${agentName}": ` +
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
      content: match.content,
    },
  };
}

function toAssetMeta(asset: ClaudePluginAsset): AssetMeta {
  return {
    kind: asset.kind,
    source: 'user',
    adapter: 'claude-code',
    origin: 'plugin',
    pluginName: asset.pluginName,
    runtimeName: asset.runtimeName,
    name: asset.name,
    qualifiedName: `plugin:${asset.pluginName}/${asset.name}`,
    description: asset.frontmatter.description ?? '',
    ...(asset.kind === 'agent'
      ? {
          tools: asset.frontmatter.tools,
          model: asset.frontmatter.model,
          thinking: asset.frontmatter.effort,
          provider: asset.frontmatter.provider,
        }
      : {}),
    absPath: asset.path,
  };
}

function compareAssets(a: AssetMeta, b: AssetMeta): number {
  return a.qualifiedName.localeCompare(b.qualifiedName);
}
