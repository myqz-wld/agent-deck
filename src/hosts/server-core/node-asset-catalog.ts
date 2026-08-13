import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

import {
  NODE_ASSET_MAX_CONTENT_BYTES,
  NODE_ASSET_MAX_ITEMS,
  parseNodeAssetContentResult,
  parseNodeAssetConventionResult,
  parseNodeAssetListResult,
  type NodeAssetAdapterId,
  type NodeAssetContentParams,
  type NodeAssetDto,
  type NodeAssetInjectionSettingsDto,
} from '@contracts/index';
import {
  scanBundledAssets,
  type BundledAssetStoreFilesystem,
} from '@main/bundled-asset-store';
import { createPluginMirrorStore } from '@main/adapters/claude-code/plugin-mirror-store';
import { formatClaudeSystemPromptAppend } from '@main/adapters/claude-code/sdk-injection-core';
import { createSkillsMirrorStore } from '@main/codex-config/skills-mirror-store';
import { createGrokResourceStore, type GrokPluginProfileOptions } from '@main/adapters/grok-build/resource-store';
import { substituteResourcesPlaceholderWithRoot } from '@main/utils/resources-placeholder-transformer';
import type { AssetMeta } from '@shared/types';

import { scanServerCoreUserAssets } from './node-asset-user-scan';
import type { ServerCoreProviderSettings } from './provider-settings';
import { isRemoteSensitiveAssetPath } from './remote-sensitive-data';
import { readRemoteSafeFile } from './remote-safe-file-read';

const READ_ONLY_REASON =
  '资产与注入状态来自 Worker 部署快照，在 Remote 中仅供查看。';
const ASSET_SCAN_CACHE_TTL_MS = 5_000;
const ASSET_SCAN_MAX_VISITED_ENTRIES = (NODE_ASSET_MAX_ITEMS + 1) * 32;

const mirrorFilesystem = {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
};

function bundledFilesystem(root: string): BundledAssetStoreFilesystem {
  const deny = (path: Parameters<typeof readFileSync>[0]): void => {
    if (isRemoteSensitiveAssetPath(String(path))) throw new Error('Sensitive asset excluded');
  };
  return {
    existsSync: ((path: Parameters<typeof existsSync>[0]) => {
      try { deny(path); return existsSync(path); } catch { return false; }
    }) as typeof existsSync,
    readFileSync: ((path: Parameters<typeof readFileSync>[0]) => {
      deny(path);
      const read = readRemoteSafeFile(String(path), {
        maximumBytes: NODE_ASSET_MAX_CONTENT_BYTES,
        root,
        sensitive: isRemoteSensitiveAssetPath,
      });
      if (!read) throw new Error('Worker asset is unavailable');
      return read.content;
    }) as typeof readFileSync,
    readdirSync: ((path: Parameters<typeof readdirSync>[0], ...args: unknown[]) => {
      deny(path);
      return (readdirSync as (...values: unknown[]) => unknown)(path, ...args);
    }) as typeof readdirSync,
    statSync: ((path: Parameters<typeof statSync>[0], ...args: unknown[]) => {
      deny(path);
      return (statSync as (...values: unknown[]) => unknown)(path, ...args);
    }) as typeof statSync,
  };
}

interface InternalNodeAsset {
  contentDigest: string;
  dto: NodeAssetDto;
  path: string;
  root: string;
}

interface InternalNodeAssetSnapshot {
  assets: InternalNodeAsset[];
  conventionDigests: Readonly<Record<NodeAssetAdapterId, string>>;
  revision: number;
  truncated: boolean;
}

export interface ServerCoreNodeAssetCatalogOptions {
  providerHomeRoot: string;
  runtimeReadRoots: readonly string[];
  stateDirectory: string;
  settings: ServerCoreProviderSettings;
  scanCacheTtlMs?: number;
  now?: () => number;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function canonicalDirectory(path: string): string | null {
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

export function resolveServerCoreResourcesRoot(runtimeReadRoots: readonly string[]): string | null {
  for (const runtimeRoot of runtimeReadRoots) {
    const canonicalRoot = canonicalDirectory(runtimeRoot);
    if (!canonicalRoot) continue;
    for (const candidate of [
      canonicalRoot,
      join(canonicalRoot, 'Resources'),
      join(canonicalRoot, 'resources'),
    ]) {
      const canonicalCandidate = canonicalDirectory(candidate);
      if (
        canonicalCandidate && inside(canonicalRoot, canonicalCandidate) &&
        existsSync(join(canonicalCandidate, 'claude-config', 'agent-deck-plugin')) &&
        existsSync(join(canonicalCandidate, 'codex-config', 'agent-deck-plugin')) &&
        existsSync(join(canonicalCandidate, 'grok-config', 'agent-deck-plugin'))
      ) return canonicalCandidate;
    }
  }
  return null;
}

function bundledRoot(resourcesRoot: string, adapterId: NodeAssetAdapterId): string {
  return join(resourcesRoot, `${adapterId === 'codex-cli' ? 'codex' : adapterId === 'claude-code' ? 'claude' : 'grok'}-config`, 'agent-deck-plugin');
}

function conventionPath(resourcesRoot: string, adapterId: NodeAssetAdapterId): string {
  if (adapterId === 'claude-code') return join(resourcesRoot, 'claude-config', 'CLAUDE.md');
  if (adapterId === 'codex-cli') return join(resourcesRoot, 'codex-config', 'CODEX_AGENTS.md');
  return join(resourcesRoot, 'grok-config', 'GROK_AGENTS.md');
}

function nullable(value: string | undefined): string | null { return value || null; }

function dto(asset: AssetMeta, location: string): NodeAssetDto {
  return {
    adapterId: asset.adapter,
    kind: asset.kind,
    source: asset.source,
    name: asset.name,
    qualifiedName: asset.qualifiedName,
    description: asset.description,
    location,
    tools: nullable(asset.tools),
    model: nullable(asset.model),
    thinking: nullable(asset.thinking),
    provider: nullable(asset.provider),
    origin: asset.origin ?? null,
    pluginName: asset.pluginName ?? null,
    runtimeName: asset.runtimeName ?? null,
  };
}

function readBounded(path: string, root: string): { path: string; content: string } {
  const read = readRemoteSafeFile(path, {
    maximumBytes: NODE_ASSET_MAX_CONTENT_BYTES,
    root,
    sensitive: isRemoteSensitiveAssetPath,
  });
  if (!read) throw new Error('Worker asset is unavailable or exceeds its bound');
  return { path: read.canonicalPath, content: read.content };
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareAsset(left: InternalNodeAsset, right: InternalNodeAsset): number {
  return left.dto.adapterId.localeCompare(right.dto.adapterId) ||
    left.dto.source.localeCompare(right.dto.source) ||
    left.dto.kind.localeCompare(right.dto.kind) || left.dto.name.localeCompare(right.dto.name);
}

function fairAssets(values: readonly InternalNodeAsset[]): InternalNodeAsset[] {
  const groups = new Map<string, InternalNodeAsset[]>();
  for (const value of [...values].sort(compareAsset)) {
    const key = `${value.dto.adapterId}\u0000${value.dto.source}`;
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  const result: InternalNodeAsset[] = [];
  const queues = [...groups.values()];
  for (let index = 0; result.length < NODE_ASSET_MAX_ITEMS + 1 && queues.length > 0;) {
    const queue = queues[index]!;
    const next = queue.shift();
    if (next) result.push(next);
    if (queue.length === 0) queues.splice(index, 1);
    else index += 1;
    if (index >= queues.length) index = 0;
  }
  return result;
}

/** Worker-owned read model plus the exact bundled resource injection paths used by new sessions. */
export class ServerCoreNodeAssetCatalog {
  readonly resourcesRoot: string;
  private readonly claudeMirror;
  private readonly codexSkillsMirror;
  private readonly grokResources;
  private readonly packagedAssets: readonly InternalNodeAsset[];
  private readonly packagedTruncated: boolean;
  private catalogRevision = 0;
  private catalogFingerprint: string | null = null;
  private scanCache: { snapshot: InternalNodeAssetSnapshot; expiresAt: number } | null = null;

  private constructor(private readonly options: ServerCoreNodeAssetCatalogOptions, root: string) {
    this.resourcesRoot = root;
    const stateRoot = join(options.stateDirectory, 'node-assets');
    this.claudeMirror = createPluginMirrorStore({
      filesystem: mirrorFilesystem,
      transformMarkdown: (content) => substituteResourcesPlaceholderWithRoot(content, root),
    });
    this.codexSkillsMirror = createSkillsMirrorStore({
      filesystem: mirrorFilesystem,
      transformMarkdown: (content) => substituteResourcesPlaceholderWithRoot(content, root),
    });
    this.grokResources = createGrokResourceStore({
      configRoot: join(root, 'grok-config'),
      userDataPath: stateRoot,
    });
    const packaged = this.scanPackagedAssets();
    this.packagedAssets = packaged.assets;
    this.packagedTruncated = packaged.truncated;
  }

  static create(options: ServerCoreNodeAssetCatalogOptions): ServerCoreNodeAssetCatalog | null {
    const root = resolveServerCoreResourcesRoot(options.runtimeReadRoots);
    return root ? new ServerCoreNodeAssetCatalog(options, root) : null;
  }

  list(_metadataRevision: number) {
    const snapshot = this.assets();
    const allAssets = snapshot.assets;
    const assets = allAssets.slice(0, NODE_ASSET_MAX_ITEMS).map((item) => item.dto);
    return parseNodeAssetListResult({
      assets,
      assetsTruncated: snapshot.truncated || allAssets.length > NODE_ASSET_MAX_ITEMS,
      injection: this.injection(),
      readOnlyReason: READ_ONLY_REASON,
      revision: snapshot.revision,
    });
  }

  content(params: NodeAssetContentParams, _metadataRevision: number) {
    const snapshot = this.assets();
    const match = snapshot.assets.find((item) =>
      item.dto.adapterId === params.adapterId && item.dto.kind === params.kind &&
      item.dto.source === params.source && item.dto.name === params.name &&
      item.dto.qualifiedName === params.qualifiedName && item.dto.location === params.location);
    if (!match) return null;
    const raw = readBounded(match.path, match.root).content;
    if (digest(raw) !== match.contentDigest) {
      this.scanCache = null;
      throw new Error('Worker asset changed after the catalog snapshot');
    }
    return parseNodeAssetContentResult({
      content: substituteResourcesPlaceholderWithRoot(raw, 'Worker packaged resources'),
      revision: snapshot.revision,
    });
  }

  convention(adapterId: NodeAssetAdapterId, _metadataRevision: number) {
    const snapshot = this.assets();
    const raw = readBounded(
      conventionPath(this.resourcesRoot, adapterId),
      this.resourcesRoot,
    ).content;
    if (digest(raw) !== snapshot.conventionDigests[adapterId]) {
      this.scanCache = null;
      throw new Error('Worker convention changed after the catalog snapshot');
    }
    return parseNodeAssetConventionResult({
      adapterId,
      content: substituteResourcesPlaceholderWithRoot(raw, 'Worker packaged resources'),
      isCustom: false,
      revision: snapshot.revision,
    });
  }

  applicationInstructions(adapterId: NodeAssetAdapterId): string {
    const content = this.readConvention(adapterId, this.resourcesRoot).trim();
    if (!content) return '';
    if (adapterId === 'claude-code') return formatClaudeSystemPromptAppend(content);
    if (adapterId === 'codex-cli') {
      return `--- Agent Deck application conventions (bundled, per-session) ---\n\n${content}`;
    }
    return content;
  }

  claudePlugins(): Array<{ type: 'local'; path: string }> {
    const path = this.claudeMirror.sync({
      source: bundledRoot(this.resourcesRoot, 'claude-code'),
      destination: join(this.options.stateDirectory, 'node-assets', 'claude-plugin'),
      includeSkills: this.options.settings.injectAgentDeckClaudeSkills,
      includeAgents: this.options.settings.injectAgentDeckClaudeAgents,
    });
    return path ? [{ type: 'local', path }] : [];
  }

  codexSkillExtraRoots(): string[] {
    const destination = join(this.options.stateDirectory, 'node-assets', 'codex-skills');
    if (!this.options.settings.injectAgentDeckCodexSkills) {
      this.codexSkillsMirror.remove(destination);
      return [];
    }
    const written = this.codexSkillsMirror.sync({
      source: join(bundledRoot(this.resourcesRoot, 'codex-cli'), 'skills'),
      destination,
    });
    return written && written.length > 0 ? [destination] : [];
  }

  grokBaselinePrompt(): Promise<string | null> {
    return this.grokResources.loadBaselinePrompt();
  }

  grokPluginProfile(options: GrokPluginProfileOptions): Promise<string | null> {
    return this.grokResources.preparePluginProfile(options);
  }

  private readConvention(adapterId: NodeAssetAdapterId, replacementRoot: string): string {
    return substituteResourcesPlaceholderWithRoot(
      readBounded(
        conventionPath(this.resourcesRoot, adapterId),
        this.resourcesRoot,
      ).content,
      replacementRoot,
    );
  }

  private injection(): NodeAssetInjectionSettingsDto {
    const settings = this.options.settings;
    return {
      injectAgentDeckClaudeSkills: settings.injectAgentDeckClaudeSkills,
      injectAgentDeckClaudeAgents: settings.injectAgentDeckClaudeAgents,
      injectAgentDeckClaudeMd: settings.injectAgentDeckClaudeMd,
      injectAgentDeckCodexSkills: settings.injectAgentDeckCodexSkills,
      injectAgentDeckCodexAgents: settings.injectAgentDeckCodexAgents,
      injectAgentDeckCodexAgentsMd: settings.injectAgentDeckCodexAgentsMd,
      injectAgentDeckGrokSkills: settings.injectAgentDeckGrokSkills,
      injectAgentDeckGrokAgents: settings.injectAgentDeckGrokAgents,
      injectAgentDeckGrokAgentsMd: settings.injectAgentDeckGrokAgentsMd,
    };
  }

  private assets(): InternalNodeAssetSnapshot {
    const now = this.options.now?.() ?? Date.now();
    if (this.scanCache && this.scanCache.expiresAt > now) return this.scanCache.snapshot;
    const providerHomeRoot = canonicalDirectory(this.options.providerHomeRoot);
    const userScan = providerHomeRoot
      ? scanServerCoreUserAssets(providerHomeRoot, {
          maxAssets: NODE_ASSET_MAX_ITEMS + 1,
          maxVisitedEntries: ASSET_SCAN_MAX_VISITED_ENTRIES,
        })
      : { assets: [], truncated: false };
    const user = providerHomeRoot
      ? userScan.assets.flatMap((asset) => {
          const internal = this.internal(
            asset,
            `Worker Provider Home/${relative(providerHomeRoot, asset.absPath)}`,
            providerHomeRoot,
          );
          return internal ? [internal] : [];
        })
      : [];
    const candidates = [...this.packagedAssets, ...user];
    const assets = fairAssets(candidates);
    const conventionDigests = Object.fromEntries(
      (['claude-code', 'codex-cli', 'grok-build'] as const).map((adapterId) => [
        adapterId,
        digest(readBounded(
          conventionPath(this.resourcesRoot, adapterId),
          this.resourcesRoot,
        ).content),
      ]),
    ) as Record<NodeAssetAdapterId, string>;
    const fingerprint = digest(JSON.stringify({
      assets: assets.map((asset) => [asset.dto, asset.contentDigest]),
      conventionDigests,
      injection: this.injection(),
      truncated: this.packagedTruncated || userScan.truncated ||
        candidates.length > NODE_ASSET_MAX_ITEMS + 1,
    }));
    if (fingerprint !== this.catalogFingerprint) {
      this.catalogFingerprint = fingerprint;
      this.catalogRevision += 1;
    }
    const snapshot = {
      assets,
      conventionDigests,
      revision: this.catalogRevision,
      truncated: this.packagedTruncated || userScan.truncated ||
        candidates.length > NODE_ASSET_MAX_ITEMS + 1,
    };
    this.scanCache = {
      snapshot,
      expiresAt: now + Math.max(0, this.options.scanCacheTtlMs ?? ASSET_SCAN_CACHE_TTL_MS),
    };
    return snapshot;
  }

  private internal(asset: AssetMeta, location: string, root: string): InternalNodeAsset | null {
    try {
      const read = readBounded(asset.absPath, root);
      return {
        contentDigest: digest(read.content),
        dto: dto(asset, location),
        path: read.path,
        root,
      };
    } catch {
      return null;
    }
  }

  private scanPackagedAssets(): { assets: InternalNodeAsset[]; truncated: boolean } {
    try {
      const bundled = scanBundledAssets([
        { adapter: 'claude-code', root: bundledRoot(this.resourcesRoot, 'claude-code') },
        { adapter: 'codex-cli', root: bundledRoot(this.resourcesRoot, 'codex-cli') },
        { adapter: 'grok-build', root: bundledRoot(this.resourcesRoot, 'grok-build') },
      ], bundledFilesystem(this.resourcesRoot));
      const candidates = [...bundled.agents, ...bundled.skills].flatMap((asset) => {
        const internal = this.internal(
          asset,
          `Worker packaged resources/${relative(this.resourcesRoot, asset.absPath)}`,
          this.resourcesRoot,
        );
        return internal ? [internal] : [];
      });
      return {
        assets: fairAssets(candidates),
        truncated: candidates.length > NODE_ASSET_MAX_ITEMS + 1,
      };
    } catch {
      return { assets: [], truncated: false };
    }
  }
}
