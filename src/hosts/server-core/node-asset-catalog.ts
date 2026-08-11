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

const READ_ONLY_REASON =
  'Remote 资产来自 Worker 的封装资源与隔离 Provider Home；当前协议只读，注入开关由 Worker 启动配置决定。';
const ASSET_SCAN_CACHE_TTL_MS = 5_000;
const ASSET_SCAN_MAX_VISITED_ENTRIES = (NODE_ASSET_MAX_ITEMS + 1) * 32;

const filesystem: BundledAssetStoreFilesystem = {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
};
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

interface InternalNodeAsset {
  dto: NodeAssetDto;
  path: string;
  root: string;
}

interface InternalNodeAssetSnapshot {
  assets: InternalNodeAsset[];
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

function readableFile(path: string, root: string): boolean {
  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical);
    return inside(root, canonical) && stat.isFile() && stat.size <= NODE_ASSET_MAX_CONTENT_BYTES;
  } catch {
    return false;
  }
}

function readBounded(path: string, root: string): string {
  if (!readableFile(path, root)) throw new Error('Worker asset is unavailable or exceeds its bound');
  return readFileSync(path, 'utf8');
}

/** Worker-owned read model plus the exact bundled resource injection paths used by new sessions. */
export class ServerCoreNodeAssetCatalog {
  readonly resourcesRoot: string;
  private readonly claudeMirror;
  private readonly codexSkillsMirror;
  private readonly grokResources;
  private readonly packagedAssets: readonly InternalNodeAsset[];
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
    this.packagedAssets = this.scanPackagedAssets();
  }

  static create(options: ServerCoreNodeAssetCatalogOptions): ServerCoreNodeAssetCatalog | null {
    const root = resolveServerCoreResourcesRoot(options.runtimeReadRoots);
    return root ? new ServerCoreNodeAssetCatalog(options, root) : null;
  }

  list(revision: number) {
    const snapshot = this.assets();
    const allAssets = snapshot.assets;
    const assets = allAssets.slice(0, NODE_ASSET_MAX_ITEMS).map((item) => item.dto);
    return parseNodeAssetListResult({
      assets,
      assetsTruncated: snapshot.truncated || allAssets.length > NODE_ASSET_MAX_ITEMS,
      injection: this.injection(),
      readOnlyReason: READ_ONLY_REASON,
      revision,
    });
  }

  content(params: NodeAssetContentParams, revision: number) {
    const match = this.assets().assets.find((item) =>
      item.dto.adapterId === params.adapterId && item.dto.kind === params.kind &&
      item.dto.source === params.source && item.dto.name === params.name &&
      item.dto.qualifiedName === params.qualifiedName && item.dto.location === params.location);
    if (!match) return null;
    const raw = readBounded(match.path, match.root);
    return parseNodeAssetContentResult({
      content: substituteResourcesPlaceholderWithRoot(raw, this.resourcesRoot),
      revision,
    });
  }

  convention(adapterId: NodeAssetAdapterId, revision: number) {
    return parseNodeAssetConventionResult({
      adapterId,
      content: this.readConvention(adapterId),
      isCustom: false,
      revision,
    });
  }

  applicationInstructions(adapterId: NodeAssetAdapterId): string {
    const content = this.readConvention(adapterId).trim();
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

  private readConvention(adapterId: NodeAssetAdapterId): string {
    return substituteResourcesPlaceholderWithRoot(
      readBounded(conventionPath(this.resourcesRoot, adapterId), this.resourcesRoot),
      this.resourcesRoot,
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
    const userLimit = Math.max(0, NODE_ASSET_MAX_ITEMS + 1 - this.packagedAssets.length);
    const userScan = providerHomeRoot && userLimit > 0
      ? scanServerCoreUserAssets(providerHomeRoot, {
          maxAssets: userLimit,
          maxVisitedEntries: ASSET_SCAN_MAX_VISITED_ENTRIES,
        })
      : { assets: [], truncated: false };
    const user = providerHomeRoot
      ? userScan.assets.map((asset) => ({
          dto: dto(asset, `Worker Provider Home/${relative(providerHomeRoot, asset.absPath)}`),
          path: asset.absPath,
          root: providerHomeRoot,
        }))
      : [];
    const assets = [...this.packagedAssets, ...user].sort((left, right) =>
      left.dto.adapterId.localeCompare(right.dto.adapterId) ||
      left.dto.kind.localeCompare(right.dto.kind) ||
      left.dto.source.localeCompare(right.dto.source) ||
      left.dto.name.localeCompare(right.dto.name));
    const snapshot = { assets, truncated: userScan.truncated };
    this.scanCache = {
      snapshot,
      expiresAt: now + Math.max(0, this.options.scanCacheTtlMs ?? ASSET_SCAN_CACHE_TTL_MS),
    };
    return snapshot;
  }

  private scanPackagedAssets(): InternalNodeAsset[] {
    try {
      const bundled = scanBundledAssets([
        { adapter: 'claude-code', root: bundledRoot(this.resourcesRoot, 'claude-code') },
        { adapter: 'codex-cli', root: bundledRoot(this.resourcesRoot, 'codex-cli') },
        { adapter: 'grok-build', root: bundledRoot(this.resourcesRoot, 'grok-build') },
      ], filesystem);
      return [...bundled.agents, ...bundled.skills]
        .slice(0, NODE_ASSET_MAX_ITEMS + 1)
        .map((asset) => ({
          dto: dto(asset, `Worker packaged resources/${relative(this.resourcesRoot, asset.absPath)}`),
          path: asset.absPath,
          root: this.resourcesRoot,
        }));
    } catch {
      return [];
    }
  }
}
