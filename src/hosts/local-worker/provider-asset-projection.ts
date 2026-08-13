import {
  lstatSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  relative,
  sep,
} from 'node:path';

import {
  NODE_ASSET_MAX_CONTENT_BYTES,
  NODE_ASSET_MAX_ITEMS,
} from '@contracts/index';
import { scanServerCoreUserAssets } from '@hosts/server-core/node-asset-user-scan';
import { isRemoteSensitiveAssetPath } from '@hosts/server-core/remote-sensitive-data';
import type { BundledAdapter } from '@main/bundled-asset-store';
import type { AssetMeta } from '@shared/types';

import {
  canonicalProviderDirectory,
  readOptionalProviderFile,
  removeProviderFile,
  writeProviderFile,
  type ProviderProjectionMode,
} from '@hosts/provider-state/provider-home-files';

const MANIFEST_PATH = '.agent-deck/local-worker-assets.json';
const MAX_SCAN_ENTRIES = (NODE_ASSET_MAX_ITEMS + 1) * 32;
const MAX_SUPPORT_ENTRIES = 8_192;
const MAX_SUPPORT_BYTES = 32 * 1024 * 1024;

interface ProjectionManifest {
  schemaVersion: 1;
  files: string[];
}

interface DesiredFile {
  bytes: Buffer;
  sourcePath: string | null;
}

interface CopyBudget {
  remainingBytes: number;
  remainingEntries: number;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function adapterRoot(adapter: BundledAdapter): string {
  if (adapter === 'claude-code') return '.claude';
  if (adapter === 'codex-cli') return '.codex';
  return '.grok';
}

function agentExtension(adapter: BundledAdapter): '.md' | '.toml' {
  return adapter === 'codex-cli' ? '.toml' : '.md';
}

function pluginAdapter(asset: AssetMeta, sourceHome: string): BundledAdapter {
  if (
    asset.adapter === 'grok-build' &&
    inside(join(sourceHome, '.claude', 'plugins'), asset.absPath)
  ) return 'claude-code';
  return asset.adapter;
}

function destinationFor(asset: AssetMeta, sourceHome: string): string {
  const adapter = asset.origin === 'plugin'
    ? pluginAdapter(asset, sourceHome)
    : asset.adapter;
  const root = adapterRoot(adapter);
  const file = asset.kind === 'agent'
    ? `${asset.name}${agentExtension(adapter)}`
    : join(asset.name, 'SKILL.md');
  if (asset.origin !== 'plugin' || !asset.pluginName) {
    return join(root, asset.kind === 'agent' ? 'agents' : 'skills', file);
  }
  return join(
    root,
    'plugins',
    'agent-deck-worker-sync',
    asset.pluginName,
    asset.kind === 'agent' ? 'agents' : 'skills',
    file,
  );
}

function pluginManifestPath(adapter: BundledAdapter, pluginName: string): string {
  const root = join(
    adapterRoot(adapter),
    'plugins',
    'agent-deck-worker-sync',
    pluginName,
  );
  return adapter === 'claude-code'
    ? join(root, '.claude-plugin', 'plugin.json')
    : adapter === 'codex-cli'
      ? join(root, '.codex-plugin', 'plugin.json')
      : join(root, 'plugin.json');
}

function readSourceFile(sourceHome: string, absolutePath: string): Buffer | null {
  if (!inside(sourceHome, absolutePath) || isRemoteSensitiveAssetPath(absolutePath)) return null;
  const sourcePath = relative(sourceHome, absolutePath);
  try {
    return readOptionalProviderFile(sourceHome, sourcePath, {
      maxBytes: NODE_ASSET_MAX_CONTENT_BYTES,
    });
  } catch {
    return null;
  }
}

function safeDirectory(sourceHome: string, path: string): boolean {
  if (!inside(sourceHome, path) || isRemoteSensitiveAssetPath(path)) return false;
  try {
    const stat = lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path &&
      (stat.mode & 0o022) === 0 && (uid === null || stat.uid === uid);
  } catch {
    return false;
  }
}

function copySkillSupport(
  sourceHome: string,
  sourceDirectory: string,
  destinationDirectory: string,
  desired: Map<string, DesiredFile>,
  budget: CopyBudget,
  prefix = '',
): void {
  if (!safeDirectory(sourceHome, sourceDirectory) || budget.remainingEntries <= 0) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.remainingEntries <= 0 || budget.remainingBytes <= 0) return;
    --budget.remainingEntries;
    const sourcePath = join(sourceDirectory, entry.name);
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (isRemoteSensitiveAssetPath(sourcePath) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copySkillSupport(
        sourceHome,
        sourcePath,
        destinationDirectory,
        desired,
        budget,
        relativePath,
      );
      continue;
    }
    if (!entry.isFile() || entry.name === 'SKILL.md') continue;
    const bytes = readSourceFile(sourceHome, sourcePath);
    if (!bytes || bytes.byteLength > budget.remainingBytes) continue;
    budget.remainingBytes -= bytes.byteLength;
    desired.set(join(destinationDirectory, relativePath), { bytes, sourcePath });
  }
}

function previousFiles(destinationHome: string): string[] {
  const bytes = readOptionalProviderFile(destinationHome, MANIFEST_PATH);
  if (!bytes) return [];
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Partial<ProjectionManifest>;
    if (
      value.schemaVersion !== 1 || !Array.isArray(value.files) ||
      value.files.some((file) => typeof file !== 'string')
    ) throw new Error('invalid Worker asset projection manifest');
    return value.files;
  } finally {
    bytes.fill(0);
  }
}

function buildDesired(sourceHome: string): Map<string, DesiredFile> {
  const scan = scanServerCoreUserAssets(sourceHome, {
    maxAssets: NODE_ASSET_MAX_ITEMS,
    maxVisitedEntries: MAX_SCAN_ENTRIES,
  });
  const desired = new Map<string, DesiredFile>();
  const supportBudget: CopyBudget = {
    remainingBytes: MAX_SUPPORT_BYTES,
    remainingEntries: MAX_SUPPORT_ENTRIES,
  };
  for (const asset of scan.assets) {
    const destination = destinationFor(asset, sourceHome);
    const bytes = readSourceFile(sourceHome, asset.absPath);
    if (!bytes || desired.has(destination)) continue;
    desired.set(destination, { bytes, sourcePath: asset.absPath });
    if (
      asset.kind === 'skill' &&
      basename(dirname(dirname(asset.absPath))) === 'skills'
    ) {
      copySkillSupport(
        sourceHome,
        dirname(asset.absPath),
        dirname(destination),
        desired,
        supportBudget,
      );
    }
    if (asset.origin === 'plugin' && asset.pluginName) {
      const adapter = pluginAdapter(asset, sourceHome);
      const manifest = pluginManifestPath(adapter, asset.pluginName);
      if (!desired.has(manifest)) {
        desired.set(manifest, {
          bytes: Buffer.from(`${JSON.stringify({ name: asset.pluginName }, null, 2)}\n`),
          sourcePath: null,
        });
      }
    }
  }
  return desired;
}

/** Synchronizes the bounded Local Agents/Skills catalog into the Worker's private Provider Home. */
export function projectLocalWorkerAssets(
  sourceHomePath: string,
  destinationHomePath: string,
  mode: ProviderProjectionMode,
): readonly string[] {
  const sourceHome = canonicalProviderDirectory(sourceHomePath, 'provider source home', false);
  const destinationHome = canonicalProviderDirectory(
    destinationHomePath,
    'provider destination home',
    true,
  );
  const desired = buildDesired(sourceHome);
  const files = [...desired.keys()].sort();
  const previous = mode === 'replace' ? previousFiles(destinationHome) : [];

  for (const path of files) {
    const entry = desired.get(path)!;
    try {
      writeProviderFile(destinationHome, path, entry.bytes, mode);
    } finally {
      if (entry.sourcePath !== null) entry.bytes.fill(0);
    }
  }
  if (mode === 'replace') {
    for (const path of previous) {
      if (!desired.has(path)) removeProviderFile(destinationHome, path);
    }
  }
  if (files.length === 0) {
    if (mode === 'replace') removeProviderFile(destinationHome, MANIFEST_PATH);
  } else {
    const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
    writeProviderFile(destinationHome, MANIFEST_PATH, manifest, mode);
  }
  return Object.freeze(files);
}
