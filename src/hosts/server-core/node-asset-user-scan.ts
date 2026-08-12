import { opendirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { NODE_ASSET_MAX_CONTENT_BYTES } from '@contracts/index';
import {
  buildAgentMeta,
  buildSkillMeta,
  type BundledAdapter,
} from '@main/bundled-asset-store';
import {
  discoverPluginRoots,
  type PluginRoot,
  type PluginTraversalBudget,
} from '@main/plugin-assets';
import { parseFrontmatter } from '@main/utils/frontmatter';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import { isNativeAssetName, type AssetMeta } from '@shared/types';
import { isRemoteSensitiveAssetPath } from './remote-sensitive-data';
import { readRemoteSafeFile } from './remote-safe-file-read';

interface PluginDiscovery {
  searchPaths: string[];
  manifestPaths: string[];
  allowContentOnly: boolean;
}

export interface ServerCoreUserAssetScanOptions {
  maxAssets: number;
  maxVisitedEntries: number;
}

export interface ServerCoreUserAssetScanResult {
  assets: AssetMeta[];
  truncated: boolean;
  visitedEntries: number;
}

interface ScanBudget extends PluginTraversalBudget {
  remainingAssets: number;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function canonicalDirectory(path: string): string | null {
  if (isRemoteSensitiveAssetPath(path)) return null;
  try {
    const canonical = realpathSync(path);
    return !isRemoteSensitiveAssetPath(canonical) && statSync(canonical).isDirectory()
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function canonicalFile(path: string, home: string): string | null {
  if (isRemoteSensitiveAssetPath(path)) return null;
  try {
    const canonical = realpathSync(path);
    if (isRemoteSensitiveAssetPath(canonical)) return null;
    const stat = statSync(canonical);
    return inside(home, canonical) && stat.isFile() && stat.size <= NODE_ASSET_MAX_CONTENT_BYTES
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function readAsset(path: string, home: string): { path: string; content: string } | null {
  const read = readRemoteSafeFile(path, {
    maximumBytes: NODE_ASSET_MAX_CONTENT_BYTES,
    root: home,
    sensitive: isRemoteSensitiveAssetPath,
  });
  return read ? { path: read.canonicalPath, content: read.content } : null;
}

function visitEntries(
  path: string,
  budget: ScanBudget,
  visit: (entry: string) => boolean,
): void {
  if (isRemoteSensitiveAssetPath(path)) return;
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(path);
  } catch {
    return;
  }
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (budget.remainingEntries <= 0) {
        budget.truncated = true;
        break;
      }
      --budget.remainingEntries;
      if (!visit(entry.name)) break;
    }
  } finally {
    try { directory.closeSync(); } catch {}
  }
}

function agentMeta(
  adapter: BundledAdapter,
  path: string,
  content: string,
  fallbackName: string,
): AssetMeta | null {
  try {
    if (adapter === 'codex-cli') {
      const parsed = parseCodexAgentToml(content);
      const name = parsed.name ?? fallbackName;
      if (!isNativeAssetName(name)) return null;
      return buildAgentMeta(name, path, {
        description: parsed.description ?? '',
        model: parsed.model ?? '',
        model_provider: typeof parsed.config.model_provider === 'string'
          ? parsed.config.model_provider
          : '',
        model_reasoning_effort: parsed.modelReasoningEffort ?? '',
      }, 'user', adapter);
    }
    const frontmatter = parseFrontmatter(content);
    const name = frontmatter.name?.trim() || fallbackName;
    return isNativeAssetName(name)
      ? buildAgentMeta(name, path, frontmatter, 'user', adapter)
      : null;
  } catch {
    return null;
  }
}

function skillMeta(
  adapter: BundledAdapter,
  path: string,
  content: string,
  fallbackName: string,
): AssetMeta | null {
  try {
    const frontmatter = parseFrontmatter(content);
    const name = frontmatter.name?.trim() || fallbackName;
    return isNativeAssetName(name)
      ? buildSkillMeta(name, path, frontmatter, 'user', adapter)
      : null;
  } catch {
    return null;
  }
}

function withOrigin(asset: AssetMeta, plugin: PluginRoot | null): AssetMeta {
  if (!plugin) return { ...asset, origin: 'direct', runtimeName: asset.name };
  return {
    ...asset,
    origin: 'plugin',
    pluginName: plugin.name,
    runtimeName: `${plugin.name}:${asset.name}`,
    qualifiedName: `plugin:${plugin.name}/${asset.name}`,
  };
}

function scanAgentPath(
  adapter: BundledAdapter,
  path: string,
  home: string,
  plugin: PluginRoot | null,
  budget: ScanBudget,
): AssetMeta[] {
  const extension = adapter === 'codex-cli' ? '.toml' : '.md';
  const assets: AssetMeta[] = [];
  const append = (candidate: string): void => {
    if (budget.remainingAssets <= 0) {
      budget.truncated = true;
      return;
    }
    const read = readAsset(candidate, home);
    if (!read) return;
    const meta = agentMeta(
      adapter,
      read.path,
      read.content,
      basename(read.path, extension),
    );
    if (meta && retainAsset(budget)) assets.push(withOrigin(meta, plugin));
  };
  const canonicalDir = canonicalDirectory(path);
  if (canonicalDir && inside(home, canonicalDir)) {
    visitEntries(canonicalDir, budget, (entry) => {
      if (entry.endsWith(extension)) append(join(canonicalDir, entry));
      return budget.remainingAssets > 0;
    });
  } else if (path.endsWith(extension)) {
    append(path);
  }
  return assets;
}

function scanSkillPath(
  adapter: BundledAdapter,
  path: string,
  home: string,
  plugin: PluginRoot | null,
  budget: ScanBudget,
): AssetMeta[] {
  const assets: AssetMeta[] = [];
  const append = (candidate: string): void => {
    if (budget.remainingAssets <= 0) {
      budget.truncated = true;
      return;
    }
    const read = readAsset(candidate, home);
    if (!read) return;
    const meta = skillMeta(adapter, read.path, read.content, basename(dirname(read.path)));
    if (meta && retainAsset(budget)) assets.push(withOrigin(meta, plugin));
  };
  const direct = canonicalFile(path, home);
  if (direct && basename(direct) === 'SKILL.md') append(direct);
  const canonicalDir = canonicalDirectory(path);
  if (canonicalDir && inside(home, canonicalDir)) {
    const rootSkill = canonicalFile(join(canonicalDir, 'SKILL.md'), home);
    if (rootSkill) append(rootSkill);
    visitEntries(canonicalDir, budget, (entry) => {
      const skill = canonicalFile(join(canonicalDir, entry, 'SKILL.md'), home);
      if (skill) append(skill);
      return budget.remainingAssets > 0;
    });
  }
  return assets;
}

function retainAsset(budget: ScanBudget): boolean {
  if (budget.remainingAssets <= 0) {
    budget.truncated = true;
    return false;
  }
  --budget.remainingAssets;
  return true;
}

function readClaudeManifest(plugin: PluginRoot, home: string): Record<string, unknown> | null {
  for (const candidate of [
    join(plugin.path, '.claude-plugin', 'plugin.json'),
    join(plugin.path, 'plugin.json'),
  ]) {
    try {
      const read = readAsset(candidate, home);
      if (!read) continue;
      const parsed = JSON.parse(read.content) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

function componentPaths(
  adapter: BundledAdapter,
  plugin: PluginRoot,
  key: 'agents' | 'skills',
  home: string,
  budget: ScanBudget,
): string[] {
  const values = [join(plugin.path, key)];
  if (adapter === 'claude-code') {
    const configured = readClaudeManifest(plugin, home)?.[key];
    const declared = typeof configured === 'string' ? [configured]
      : Array.isArray(configured) ? configured : [];
    for (const value of declared) {
      if (typeof value !== 'string') continue;
      if (budget.remainingEntries <= 0) {
        budget.truncated = true;
        break;
      }
      --budget.remainingEntries;
      values.push(resolve(plugin.path, value));
    }
  }
  return [...new Set(values)].filter((value) => {
    if (isRemoteSensitiveAssetPath(value)) return false;
    const canonical = canonicalDirectory(value) ?? canonicalFile(value, home);
    return canonical !== null && inside(home, canonical) && inside(plugin.path, canonical);
  });
}

function pluginDiscovery(home: string, adapter: BundledAdapter): PluginDiscovery {
  if (adapter === 'claude-code') {
    return {
      searchPaths: [join(home, '.claude', 'plugins')],
      manifestPaths: ['.claude-plugin/plugin.json', 'plugin.json'],
      allowContentOnly: true,
    };
  }
  if (adapter === 'codex-cli') {
    return {
      searchPaths: [
        join(home, '.codex', 'plugins', 'cache'),
        join(home, '.codex', 'plugins'),
        join(home, '.agents', 'plugins'),
      ],
      manifestPaths: ['.codex-plugin/plugin.json'],
      allowContentOnly: false,
    };
  }
  return {
    searchPaths: [join(home, '.grok', 'plugins'), join(home, '.claude', 'plugins')],
    manifestPaths: ['plugin.json'],
    allowContentOnly: true,
  };
}

function scanPlugins(
  home: string,
  adapter: BundledAdapter,
  budget: ScanBudget,
): AssetMeta[] {
  if (budget.remainingAssets <= 0) {
    budget.truncated = true;
    return [];
  }
  const discovery = pluginDiscovery(home, adapter);
  const plugins = discoverPluginRoots({
    ...discovery,
    maxDepth: 6,
    maxManifestBytes: NODE_ASSET_MAX_CONTENT_BYTES,
    maxResults: budget.remainingAssets,
    traversalBudget: budget,
    denyPath: isRemoteSensitiveAssetPath,
    readManifest: (path) => readAsset(path, home)?.content ?? null,
  })
    .filter((plugin) => inside(home, plugin.path) && isNativeAssetName(plugin.name));
  const assets: AssetMeta[] = [];
  for (const plugin of plugins) {
    for (const path of componentPaths(adapter, plugin, 'agents', home, budget)) {
      assets.push(...scanAgentPath(adapter, path, home, plugin, budget));
    }
    if (adapter === 'claude-code') {
      assets.push(...scanSkillPath(
        adapter,
        join(plugin.path, 'SKILL.md'),
        home,
        plugin,
        budget,
      ));
    }
    for (const path of componentPaths(adapter, plugin, 'skills', home, budget)) {
      assets.push(...scanSkillPath(adapter, path, home, plugin, budget));
    }
    if (budget.remainingAssets <= 0) break;
  }
  return assets;
}

function scanAdapter(
  home: string,
  adapter: BundledAdapter,
  maxAssets: number,
  maxVisitedEntries: number,
): { assets: AssetMeta[]; truncated: boolean; visitedEntries: number } {
  const budget: ScanBudget = {
    remainingAssets: maxAssets,
    remainingEntries: maxVisitedEntries,
    truncated: maxAssets === 0,
  };
  const config = join(
    home,
    adapter === 'claude-code' ? '.claude' : adapter === 'codex-cli' ? '.codex' : '.grok',
  );
  const scanned = [
    ...scanAgentPath(adapter, join(config, 'agents'), home, null, budget),
    ...scanSkillPath(adapter, join(config, 'skills'), home, null, budget),
    ...scanPlugins(home, adapter, budget),
  ];
  const unique = new Map<string, AssetMeta>();
  for (const asset of scanned) {
    const canonical = canonicalFile(asset.absPath, home);
    if (canonical) unique.set(`${asset.kind}\u0000${canonical}`, asset);
  }
  return {
    assets: [...unique.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.qualifiedName.localeCompare(right.qualifiedName) ||
      left.absPath.localeCompare(right.absPath)),
    truncated: budget.truncated || budget.remainingAssets === 0,
    visitedEntries: maxVisitedEntries - budget.remainingEntries,
  };
}

function selectFairly(groups: readonly AssetMeta[][], maximum: number): AssetMeta[] {
  const queues = groups.map((group) => [...group]);
  const result: AssetMeta[] = [];
  for (let index = 0; result.length < maximum && queues.length > 0;) {
    const queue = queues[index]!;
    const next = queue.shift();
    if (next) result.push(next);
    if (queue.length === 0) queues.splice(index, 1);
    else index += 1;
    if (index >= queues.length) index = 0;
  }
  return result;
}

/** Read-only native asset inventory fenced to the Worker's isolated Provider Home. */
export function scanServerCoreUserAssets(
  providerHomeRoot: string,
  options: ServerCoreUserAssetScanOptions,
): ServerCoreUserAssetScanResult {
  const home = canonicalDirectory(providerHomeRoot);
  if (!home) return { assets: [], truncated: false, visitedEntries: 0 };
  const maxAssets = Math.max(0, Math.floor(options.maxAssets));
  const maxVisitedEntries = Math.max(0, Math.floor(options.maxVisitedEntries));
  const adapters = ['claude-code', 'codex-cli', 'grok-build'] as const;
  const baseEntries = Math.floor(maxVisitedEntries / adapters.length);
  const remainder = maxVisitedEntries % adapters.length;
  const scans = adapters.map((adapter, index) => scanAdapter(
    home,
    adapter,
    maxAssets,
    baseEntries + (index < remainder ? 1 : 0),
  ));
  const result = selectFairly(scans.map((scan) => scan.assets), maxAssets);
  const discovered = scans.reduce((total, scan) => total + scan.assets.length, 0);
  return {
    assets: result,
    truncated: scans.some((scan) => scan.truncated) || discovered > maxAssets,
    visitedEntries: scans.reduce((total, scan) => total + scan.visitedEntries, 0),
  };
}
