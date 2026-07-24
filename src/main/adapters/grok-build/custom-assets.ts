import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  GROK_ASSET_NAME_REGEX,
  type AssetMeta,
  type UserAssetsSnapshot,
} from '@shared/types';
import { parseFrontmatter } from '@main/utils/frontmatter';
import log from '@main/utils/logger';

const logger = log.scope('grok-custom-assets');
const PLUGIN_WALK_DEPTH = 4;

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
  editable: boolean;
  pluginName?: string;
  pluginDir?: string;
}

export function isSafeGrokAssetName(name: string): boolean {
  return name.length <= 128 && GROK_ASSET_NAME_REGEX.test(name);
}

export function getGrokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.grok');
}

export function getGrokUserWritePath(kind: 'agent' | 'skill', name: string): string {
  const root = getGrokHome();
  return kind === 'agent'
    ? join(root, 'agents', `${name}.md`)
    : join(root, 'skills', name, 'SKILL.md');
}

export function listGrokUserAssets(): UserAssetsSnapshot {
  const roots = getRoots();
  const agents = scanAgentDir(join(roots.grokHome, 'agents'), true);
  const skills = scanSkillDir(join(roots.grokHome, 'skills'), true);
  const plugins = discoverPluginRoots(getUserPluginSearchPaths(roots));
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
  if (!isSafeGrokAssetName(agentName)) {
    return { ok: false, reason: `invalid Grok agent name: ${agentName}` };
  }
  const projectRoots = getProjectRoots(cwd);
  for (const projectRoot of projectRoots) {
    const direct = findAgent(scanAgentDir(join(projectRoot, 'agents'), true), agentName);
    if (direct) return toResolvedAgent(direct, 'project');
    const plugins = discoverPluginRoots(getProjectPluginSearchPaths(projectRoot));
    for (const plugin of plugins) {
      const match = findAgent(scanPluginAgents(plugin), agentName);
      if (match) return toResolvedAgent(match, 'plugin');
    }
  }

  const roots = getRoots();
  const direct = findAgent(scanAgentDir(join(roots.grokHome, 'agents'), true), agentName);
  if (direct) return toResolvedAgent(direct, 'user');
  const plugins = discoverPluginRoots(getUserPluginSearchPaths(roots));
  for (const plugin of plugins) {
    const match = findAgent(scanPluginAgents(plugin), agentName);
    if (match) return toResolvedAgent(match, 'plugin');
  }

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
  if (pathHint && isAllowedGrokAssetPath(pathHint, kind, name, roots)) return pathHint;

  const direct = findAsset(
    kind,
    kind === 'agent'
      ? scanAgentDir(join(roots.grokHome, 'agents'), true)
      : scanSkillDir(join(roots.grokHome, 'skills'), true),
    name,
  );
  if (direct) return direct.path;
  const plugins = discoverPluginRoots(getUserPluginSearchPaths(roots));
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

export function isEditableGrokUserAssetPath(path: string, kind: 'agent' | 'skill', name: string): boolean {
  const roots = getRoots();
  const directRoot = join(roots.grokHome, kind === 'agent' ? 'agents' : 'skills');
  return isAllowedGrokAssetPath(path, kind, name, roots, directRoot);
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

interface PluginRoot {
  path: string;
  name: string;
}

function discoverPluginRoots(searchPaths: string[]): PluginRoot[] {
  const found = new Map<string, PluginRoot>();
  for (const searchPath of searchPaths) walkPluginRoots(resolve(searchPath), 0, found);
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function walkPluginRoots(path: string, depth: number, found: Map<string, PluginRoot>): void {
  if (!safeIsDir(path)) return;
  if (isPluginRoot(path)) {
    const normalized = normalizeExistingPath(path);
    if (normalized) found.set(normalized, { path: normalized, name: readPluginName(normalized) });
    return;
  }
  if (depth >= PLUGIN_WALK_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    logger.warn(`[grok-custom-assets] cannot scan plugin directory: ${path}`, error);
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    walkPluginRoots(join(path, entry), depth + 1, found);
  }
}

function isPluginRoot(path: string): boolean {
  return safeIsFile(join(path, 'plugin.json')) || safeIsDir(join(path, 'agents')) || safeIsDir(join(path, 'skills'));
}

function readPluginName(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(path, 'plugin.json'), 'utf8')) as { name?: unknown };
    if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
  } catch {
    // A manifest is optional; the directory name remains a stable display fallback.
  }
  return basename(path);
}

function scanAgentDir(
  dir: string,
  editable: boolean,
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
        editable,
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
  editable: boolean,
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
        editable,
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
  return scanAgentDir(join(plugin.path, 'agents'), false, plugin.name, plugin.path);
}

function scanPluginSkills(plugin: PluginRoot): GrokAssetDescriptor[] {
  return scanSkillDir(join(plugin.path, 'skills'), false, plugin.name, plugin.path);
}

function findAgent(assets: GrokAssetDescriptor[], name: string): GrokAssetDescriptor | null {
  return assets.find((asset) => asset.name === name) ?? null;
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
    name: asset.name,
    qualifiedName: asset.pluginName ? `plugin:${asset.pluginName}/${asset.name}` : asset.name,
    description: asset.frontmatter.description ?? '',
    ...(asset.kind === 'agent'
      ? {
          tools: asset.frontmatter.tools,
          model: asset.frontmatter.model,
          thinking: asset.frontmatter.effort || asset.frontmatter.model_reasoning_effort || undefined,
        }
      : {}),
    ...(asset.editable ? {} : { editable: false }),
    absPath: asset.path,
  };
}

function isAllowedGrokAssetPath(
  path: string,
  kind: 'agent' | 'skill',
  name: string,
  roots: GrokRoots,
  onlyRoot?: string,
): boolean {
  if (!isAbsolute(path) || !existsSync(path)) return false;
  const normalized = normalizeExistingPath(path);
  if (!normalized) return false;
  const allowedRoots = onlyRoot
    ? [onlyRoot]
    : [
        join(roots.grokHome, 'agents'),
        join(roots.grokHome, 'skills'),
        ...discoverPluginRoots(getUserPluginSearchPaths(roots)).map((plugin) => plugin.path),
      ];
  if (!allowedRoots.some((root) => isWithinRealPath(normalized, root))) return false;
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

function normalizeExistingPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isWithinRealPath(child: string, parent: string): boolean {
  const normalizedParent = normalizeExistingPath(parent);
  if (!normalizedParent) return false;
  const rel = relative(normalizedParent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function compareAssets(a: AssetMeta, b: AssetMeta): number {
  return a.name.localeCompare(b.name) || a.qualifiedName.localeCompare(b.qualifiedName);
}

function safeIsDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
