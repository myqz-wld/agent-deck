import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import {
  isNativeAssetName,
  type AssetMeta,
  type UserAssetsSnapshot,
} from '@shared/types';
import { parseFrontmatter } from '@main/utils/frontmatter';
import log from '@main/utils/logger';
import {
  discoverPluginRoots,
  isWithinExistingRoot,
  normalizeExistingPath,
  safeIsDir,
  safeIsFile,
  type PluginRoot,
} from '@main/plugin-assets';

const logger = log.scope('grok-custom-assets');

export type GrokCustomAgentSource = 'project' | 'user' | 'plugin';

export interface GrokCustomAgentContent {
  name: string;
  source: GrokCustomAgentSource;
  sourcePath: string;
  pluginDir?: string;
  content: string;
  frontmatter: Record<string, string>;
}

interface GrokRoots {
  grokHome: string;
  claudeHome: string;
}

interface GrokAssetDescriptor {
  kind: 'agent' | 'skill';
  name: string;
  path: string;
  frontmatter: Record<string, string>;
  pluginName?: string;
  pluginDir?: string;
}

export function isSafeGrokAssetName(name: string): boolean {
  return isNativeAssetName(name);
}

function isSafeGrokAgentSelector(name: string): boolean {
  if (isSafeGrokAssetName(name)) return true;
  const parts = name.split(':');
  return parts.length === 2 && parts.every(isSafeGrokAssetName);
}

export function getGrokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.grok');
}

export function listGrokUserAssets(): UserAssetsSnapshot {
  const roots = getRoots();
  const agents = scanAgentDir(join(roots.grokHome, 'agents'));
  const skills = scanSkillDir(join(roots.grokHome, 'skills'));
  const plugins = discoverGrokPluginRoots(getUserPluginSearchPaths(roots));
  for (const plugin of plugins) {
    agents.push(...scanPluginAgents(plugin));
    skills.push(...scanPluginSkills(plugin));
  }
  return {
    agents: agents.map(toAssetMeta).sort(compareAssets),
    skills: skills.map(toAssetMeta).sort(compareAssets),
  };
}

export function resolveGrokUserAgentContent(
  agentName: string,
  cwd: string,
): { ok: true; agent: GrokCustomAgentContent } | { ok: false; reason: string } {
  if (!isSafeGrokAgentSelector(agentName)) {
    return { ok: false, reason: `invalid Grok agent name: ${agentName}` };
  }
  const qualified = agentName.includes(':');
  const projectRoots = getProjectRoots(cwd);
  for (const projectRoot of projectRoots) {
    if (!qualified) {
      const direct = findAgent(scanAgentDir(join(projectRoot, 'agents')), agentName);
      if (direct) return toResolvedAgent(direct, 'project');
    }
    const plugins = discoverGrokPluginRoots(getProjectPluginSearchPaths(projectRoot));
    const plugin = findPluginAgent(plugins, agentName, `project plugins under ${projectRoot}`);
    if (plugin.ok) return toResolvedAgent(plugin.asset, 'plugin');
    if (!plugin.reason.startsWith('not found')) return plugin;
  }

  const roots = getRoots();
  if (!qualified) {
    const direct = findAgent(scanAgentDir(join(roots.grokHome, 'agents')), agentName);
    if (direct) return toResolvedAgent(direct, 'user');
  }
  const plugins = discoverGrokPluginRoots(getUserPluginSearchPaths(roots));
  const plugin = findPluginAgent(plugins, agentName, 'user Grok plugins');
  if (plugin.ok) return toResolvedAgent(plugin.asset, 'plugin');
  if (!plugin.reason.startsWith('not found')) return plugin;

  return {
    ok: false,
    reason:
      `not found: Grok agent "${agentName}". Checked project .grok/agents directories, ` +
      `project plugins, ${join(roots.grokHome, 'agents')}, and user plugins.`,
  };
}

export function getGrokUserAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  pathHint?: string,
): string | null {
  if (!isSafeGrokAssetName(name)) return null;
  const roots = getRoots();
  if (pathHint) return isAllowedGrokAssetPath(pathHint, kind, name, roots) ? pathHint : null;

  const direct = findAsset(
    kind,
    kind === 'agent'
      ? scanAgentDir(join(roots.grokHome, 'agents'))
      : scanSkillDir(join(roots.grokHome, 'skills')),
    name,
  );
  if (direct) return direct.path;
  const plugins = discoverGrokPluginRoots(getUserPluginSearchPaths(roots));
  for (const plugin of plugins) {
    const match = findAsset(
      kind,
      kind === 'agent'
        ? scanPluginAgents(plugin)
        : scanPluginSkills(plugin),
      name,
    );
    if (match) return match.path;
  }
  return null;
}

function getRoots(): GrokRoots {
  return {
    grokHome: getGrokHome(),
    claudeHome: join(homedir(), '.claude'),
  };
}

function getProjectRoots(cwd: string): string[] {
  const roots: string[] = [];
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, '.grok');
    if (safeIsDir(candidate)) roots.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function getProjectPluginSearchPaths(projectRoot: string): string[] {
  return [
    join(projectRoot, 'plugins'),
    ...readPluginPaths(join(projectRoot, 'config.toml'), projectRoot),
  ];
}

function getUserPluginSearchPaths(roots: GrokRoots): string[] {
  return [
    join(roots.grokHome, 'plugins'),
    join(roots.claudeHome, 'plugins'),
    ...readPluginPaths(join(roots.grokHome, 'config.toml'), roots.grokHome),
  ];
}

function readPluginPaths(configPath: string, baseDir: string): string[] {
  if (!safeIsFile(configPath)) return [];
  try {
    const text = readFileSync(configPath, 'utf8');
    const section = text.match(/^\[plugins\]([\s\S]*?)(?=^\[[^\]]+\]|$)/m)?.[1];
    const values = section?.match(/^\s*paths\s*=\s*\[([\s\S]*?)\]/m)?.[1];
    if (!values) return [];
    return [...values.matchAll(/(["'])(.*?)\1/g)].map((match) => {
      const value = match[2].trim();
      if (value.startsWith('~/')) return join(homedir(), value.slice(2));
      return isAbsolute(value) ? value : resolve(baseDir, value);
    });
  } catch (error) {
    logger.warn(`[grok-custom-assets] cannot read plugin paths: ${configPath}`, error);
    return [];
  }
}

function discoverGrokPluginRoots(searchPaths: string[]): PluginRoot[] {
  return discoverPluginRoots({
    searchPaths,
    manifestPaths: ['plugin.json'],
    allowContentOnly: true,
    maxDepth: 4,
  });
}

function scanAgentDir(
  dir: string,
  pluginName?: string,
  pluginDir?: string,
): GrokAssetDescriptor[] {
  if (!safeIsDir(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    logger.warn(`[grok-custom-assets] cannot scan agents: ${dir}`, error);
    return [];
  }
  const out: GrokAssetDescriptor[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const path = join(dir, entry);
    if (!safeIsFile(path)) continue;
    try {
      const frontmatter = parseFrontmatter(readFileSync(path, 'utf8'));
      const name = frontmatter.name?.trim() || entry.slice(0, -3);
      if (!isSafeGrokAssetName(name)) continue;
      out.push({
        kind: 'agent',
        name,
        path,
        frontmatter,
        ...(pluginName ? { pluginName } : {}),
        ...(pluginDir ? { pluginDir } : {}),
      });
    } catch (error) {
      logger.warn(`[grok-custom-assets] skip agent ${path}`, error);
    }
  }
  return out;
}

function scanSkillDir(
  dir: string,
  pluginName?: string,
  pluginDir?: string,
): GrokAssetDescriptor[] {
  if (!safeIsDir(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    logger.warn(`[grok-custom-assets] cannot scan skills: ${dir}`, error);
    return [];
  }
  const out: GrokAssetDescriptor[] = [];
  for (const entry of entries.sort()) {
    if (!isSafeGrokAssetName(entry)) continue;
    const skillPath = join(dir, entry, 'SKILL.md');
    if (!safeIsFile(skillPath)) continue;
    try {
      const frontmatter = parseFrontmatter(readFileSync(skillPath, 'utf8'));
      const name = frontmatter.name?.trim() || entry;
      if (!isSafeGrokAssetName(name)) continue;
      out.push({
        kind: 'skill',
        name,
        path: skillPath,
        frontmatter,
        ...(pluginName ? { pluginName } : {}),
        ...(pluginDir ? { pluginDir } : {}),
      });
    } catch (error) {
      logger.warn(`[grok-custom-assets] skip skill ${skillPath}`, error);
    }
  }
  return out;
}

function scanPluginAgents(plugin: PluginRoot): GrokAssetDescriptor[] {
  return scanAgentDir(join(plugin.path, 'agents'), plugin.name, plugin.path);
}

function scanPluginSkills(plugin: PluginRoot): GrokAssetDescriptor[] {
  return scanSkillDir(join(plugin.path, 'skills'), plugin.name, plugin.path);
}

function findAgent(assets: GrokAssetDescriptor[], name: string): GrokAssetDescriptor | null {
  return assets.find((asset) => asset.name === name) ?? null;
}

function findPluginAgent(
  plugins: PluginRoot[],
  selector: string,
  scope: string,
): { ok: true; asset: GrokAssetDescriptor } | { ok: false; reason: string } {
  const matches = plugins
    .flatMap(scanPluginAgents)
    .filter((asset) =>
      selector.includes(':')
        ? `${asset.pluginName}:${asset.name}` === selector
        : asset.name === selector
    );
  if (matches.length === 0) return { ok: false, reason: `not found in ${scope}` };
  if (matches.length > 1) {
    return {
      ok: false,
      reason:
        `multiple Grok plugin agents match "${selector}": ` +
        matches.map((asset) => `${asset.pluginName}:${asset.name}`).join(', '),
    };
  }
  return { ok: true, asset: matches[0] };
}

function findAsset(
  kind: 'agent' | 'skill',
  assets: GrokAssetDescriptor[],
  name: string,
): GrokAssetDescriptor | null {
  return assets.find((asset) => asset.kind === kind && asset.name === name) ?? null;
}

function toResolvedAgent(
  asset: GrokAssetDescriptor,
  source: GrokCustomAgentSource,
): { ok: true; agent: GrokCustomAgentContent } {
  return {
    ok: true,
    agent: {
      name: asset.name,
      source,
      sourcePath: asset.path,
      ...(asset.pluginDir ? { pluginDir: asset.pluginDir } : {}),
      content: readFileSync(asset.path, 'utf8'),
      frontmatter: asset.frontmatter,
    },
  };
}

function toAssetMeta(asset: GrokAssetDescriptor): AssetMeta {
  return {
    kind: asset.kind,
    source: 'user',
    adapter: 'grok-build',
    origin: asset.pluginName ? 'plugin' : 'direct',
    ...(asset.pluginName ? { pluginName: asset.pluginName } : {}),
    runtimeName: asset.pluginName ? `${asset.pluginName}:${asset.name}` : asset.name,
    name: asset.name,
    qualifiedName: asset.pluginName ? `plugin:${asset.pluginName}/${asset.name}` : asset.name,
    description: asset.frontmatter.description ?? '',
    ...(asset.kind === 'agent'
      ? {
          tools: asset.frontmatter.tools,
          model: asset.frontmatter.model,
          thinking: asset.frontmatter.effort || undefined,
        }
      : {}),
    absPath: asset.path,
  };
}

function isAllowedGrokAssetPath(
  path: string,
  kind: 'agent' | 'skill',
  name: string,
  roots: GrokRoots,
): boolean {
  if (!isAbsolute(path) || !existsSync(path)) return false;
  const normalized = normalizeExistingPath(path);
  if (!normalized) return false;
  const allowedRoots = [
    join(roots.grokHome, 'agents'),
    join(roots.grokHome, 'skills'),
    ...discoverGrokPluginRoots(getUserPluginSearchPaths(roots)).map((plugin) => plugin.path),
  ];
  if (!allowedRoots.some((root) => isWithinExistingRoot(normalized, root))) return false;
  if (kind === 'agent' && !path.endsWith('.md')) return false;
  if (kind === 'skill' && basename(path) !== 'SKILL.md') return false;
  try {
    const frontmatter = parseFrontmatter(readFileSync(normalized, 'utf8'));
    const fallbackName = kind === 'agent' ? basename(normalized, '.md') : basename(dirname(normalized));
    return (frontmatter.name?.trim() || fallbackName) === name;
  } catch {
    return false;
  }
}

function compareAssets(a: AssetMeta, b: AssetMeta): number {
  return a.name.localeCompare(b.name) || a.qualifiedName.localeCompare(b.qualifiedName);
}
