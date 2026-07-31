import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  discoverPluginRoots,
  isWithinExistingRoot,
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

interface ClaudePluginContainer {
  path: string;
  allowContentOnly: boolean;
}

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
      discoverClaudePluginRoots([pluginContainer.path], pluginContainer.allowContentOnly),
      agentName,
      `project plugins under ${pluginContainer.path}`,
    );
    if (result.ok || !result.reason.startsWith('not found')) return result;
  }
  return { ok: false, reason: 'not found in project Claude plugin directories' };
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
  return mergePluginRoots([
    ...discoverClaudePluginRoots(installed, true),
    ...discoverClaudePluginRoots([join(configRoot, 'plugins')], true),
    ...discoverClaudePluginRoots([join(configRoot, 'skills')]),
  ]);
}

function getProjectPluginContainers(cwd: string): ClaudePluginContainer[] {
  const containers: ClaudePluginContainer[] = [];
  const start = resolve(cwd);
  const skillsDir = join(start, '.claude', 'skills');
  if (safeIsDir(skillsDir)) containers.push({ path: skillsDir, allowContentOnly: false });
  let current = start;
  while (true) {
    const candidate = join(current, '.claude', 'plugins');
    if (safeIsDir(candidate)) containers.push({ path: candidate, allowContentOnly: true });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return containers;
}

function discoverClaudePluginRoots(
  searchPaths: string[],
  allowContentOnly = false,
): PluginRoot[] {
  return discoverPluginRoots({
    searchPaths,
    manifestPaths: ['.claude-plugin/plugin.json', 'plugin.json'],
    allowContentOnly,
    maxDepth: 6,
  });
}

function mergePluginRoots(roots: PluginRoot[]): PluginRoot[] {
  const merged = new Map<string, PluginRoot>();
  for (const root of roots) merged.set(root.path, root);
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function hasClaudePluginManifest(path: string): boolean {
  return safeIsFile(join(path, '.claude-plugin', 'plugin.json')) ||
    safeIsFile(join(path, 'plugin.json'));
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
  const assets = [
    ...pluginComponentPaths(plugin, 'agents').flatMap((path) => scanAgentPath(plugin, path)),
    ...[join(plugin.path, 'SKILL.md'), ...pluginComponentPaths(plugin, 'skills')]
      .flatMap((path) => scanSkillPath(plugin, path)),
  ];
  const unique = new Map<string, ClaudePluginAsset>();
  for (const asset of assets) {
    unique.set(`${asset.kind}:${normalizeExistingPath(asset.path) ?? asset.path}`, asset);
  }
  return [...unique.values()];
}

function pluginComponentPaths(plugin: PluginRoot, key: 'agents' | 'skills'): string[] {
  const configured = readClaudePluginManifest(plugin.path)?.[key];
  const declared = typeof configured === 'string'
    ? [configured]
    : Array.isArray(configured)
      ? configured.filter((value): value is string => typeof value === 'string')
      : [];
  const paths = [join(plugin.path, key), ...declared.map((path) => resolve(plugin.path, path))];
  const unique = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeExistingPath(path);
    if (normalized && isWithinExistingRoot(normalized, plugin.path)) unique.add(normalized);
  }
  return [...unique];
}

function readClaudePluginManifest(path: string): Record<string, unknown> | null {
  for (const manifestPath of [
    join(path, '.claude-plugin', 'plugin.json'),
    join(path, 'plugin.json'),
  ]) {
    if (!safeIsFile(manifestPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch (error) {
      logger.warn(`[claude-plugin-assets] cannot read manifest: ${manifestPath}`, error);
      return null;
    }
  }
  return null;
}

function scanAgentPath(plugin: PluginRoot, path: string): ClaudePluginAsset[] {
  if (safeIsFile(path)) {
    if (!path.endsWith('.md')) return [];
    const asset = readMarkdownAsset('agent', plugin, path, basename(path, '.md'));
    return asset ? [asset] : [];
  }
  if (!safeIsDir(path)) return [];
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return [];
  }
  const assets: ClaudePluginAsset[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const assetPath = join(path, entry);
    if (!safeIsFile(assetPath)) continue;
    const asset = readMarkdownAsset('agent', plugin, assetPath, basename(entry, '.md'));
    if (asset) assets.push(asset);
  }
  return assets;
}

function scanSkillPath(plugin: PluginRoot, path: string): ClaudePluginAsset[] {
  if (safeIsFile(path)) {
    if (basename(path) !== 'SKILL.md') return [];
    const asset = readMarkdownAsset('skill', plugin, path, basename(dirname(path)));
    return asset ? [asset] : [];
  }
  if (!safeIsDir(path)) return [];
  const assets: ClaudePluginAsset[] = [];
  const rootSkillPath = join(path, 'SKILL.md');
  if (safeIsFile(rootSkillPath)) {
    const asset = readMarkdownAsset('skill', plugin, rootSkillPath, basename(path));
    if (asset) assets.push(asset);
  }
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return assets;
  }
  for (const entry of entries.sort()) {
    const assetPath = join(path, entry, 'SKILL.md');
    if (!safeIsFile(assetPath)) continue;
    const asset = readMarkdownAsset('skill', plugin, assetPath, entry);
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
          provider: asset.frontmatter.gateway ?? asset.frontmatter.provider,
        }
      : {}),
    absPath: asset.path,
  };
}

function compareAssets(a: AssetMeta, b: AssetMeta): number {
  return a.qualifiedName.localeCompare(b.qualifiedName);
}
