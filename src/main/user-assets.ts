/**
 * Read-only discovery for native Agents and Skills across Claude Code, Codex CLI, and Grok.
 *
 * Agent Deck never creates, edits, or deletes user-owned assets. Direct roots and plugin
 * components are discovered for inspection and Finder/Explorer reveal only; each native CLI
 * remains the source of truth for installation, enablement, and mutation.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AssetMeta } from '@shared/types';
import { isNativeAssetName } from '@shared/types';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import { __metaBuilders } from './bundled-assets';
import { parseFrontmatter } from './utils/frontmatter';
import {
  getClaudeConfigRoot,
  getClaudePluginAssetPath,
  hasClaudePluginManifest,
} from './claude-config/plugin-assets';
import {
  getCodexHome,
  getCodexPluginAssetPath,
} from './codex-config/plugin-assets';
import {
  getGrokUserAssetPath,
} from './adapters/grok-build/custom-assets';
import { normalizeExistingPath, safeIsDir, safeIsFile } from './plugin-assets';
import log from '@main/utils/logger';

const logger = log.scope('main-user-assets');

type UserAdapter = 'claude-code' | 'codex-cli' | 'grok-build';
type DirectAssetsSnapshot = { agents: AssetMeta[]; skills: AssetMeta[] };

export function getUserAssetContent(
  kind: 'agent' | 'skill',
  name: string,
  adapter: UserAdapter,
  pathHint?: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const path = getUserAssetPath(kind, name, adapter, pathHint);
  if (!path) return { ok: false, reason: `not found: ${adapter}/${kind}/${name}` };
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function getUserAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  adapter: UserAdapter,
  pathHint?: string,
): string | null {
  if (!isNativeAssetName(name)) return null;
  if (adapter === 'grok-build') return getGrokUserAssetPath(kind, name, pathHint);

  if (pathHint) {
    const normalizedHint = normalizeExistingPath(pathHint);
    if (!normalizedHint) return null;
    const pluginPath = adapter === 'claude-code'
      ? getClaudePluginAssetPath(kind, name, pathHint)
      : getCodexPluginAssetPath(kind, name, pathHint);
    return pluginPath ?? findDirectAssetPath(adapter, kind, name, normalizedHint);
  }

  const directPath = findDirectAssetPath(adapter, kind, name);
  if (directPath) return directPath;
  return adapter === 'claude-code'
    ? getClaudePluginAssetPath(kind, name)
    : getCodexPluginAssetPath(kind, name);
}

function findDirectAssetPath(
  adapter: 'claude-code' | 'codex-cli',
  kind: 'agent' | 'skill',
  name: string,
  normalizedHint?: string,
): string | null {
  const directAssets = listDirectAssets(adapter)[kind === 'agent' ? 'agents' : 'skills'];
  const direct = directAssets.find((asset) =>
    asset.name === name &&
    (!normalizedHint || normalizeExistingPath(asset.absPath) === normalizedHint)
  );
  return direct?.absPath ?? null;
}

function listDirectAssets(adapter: 'claude-code' | 'codex-cli'): DirectAssetsSnapshot {
  return {
    agents: adapter === 'claude-code' ? scanClaudeAgents() : scanCodexAgents(),
    skills: scanSkills(adapter),
  };
}

function scanClaudeAgents(): AssetMeta[] {
  const root = join(getClaudeConfigRoot(), 'agents');
  if (!safeIsDir(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    logger.warn(`[user-assets] cannot scan Claude agents: ${root}`, error);
    return [];
  }
  const assets: AssetMeta[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const path = join(root, entry);
    if (!safeIsFile(path)) continue;
    try {
      const frontmatter = parseFrontmatter(readFileSync(path, 'utf8'));
      const name = frontmatter.name?.trim() || basename(entry, '.md');
      if (!isNativeAssetName(name)) continue;
      assets.push(asReadOnlyDirect(
        __metaBuilders.buildAgentMeta(name, path, frontmatter, 'user', 'claude-code'),
      ));
    } catch (error) {
      logger.warn(`[user-assets] skip Claude agent ${path}`, error);
    }
  }
  return assets;
}

function scanCodexAgents(): AssetMeta[] {
  const root = join(getCodexHome(), 'agents');
  if (!safeIsDir(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    logger.warn(`[user-assets] cannot scan Codex agents: ${root}`, error);
    return [];
  }
  const assets: AssetMeta[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.toml')) continue;
    const path = join(root, entry);
    if (!safeIsFile(path)) continue;
    try {
      const parsed = parseCodexAgentToml(readFileSync(path, 'utf8'));
      if (!parsed.name || !isNativeAssetName(parsed.name)) continue;
      assets.push(asReadOnlyDirect(__metaBuilders.buildAgentMeta(
        parsed.name,
        path,
        {
          description: parsed.description ?? '',
          model: parsed.model ?? '',
          model_provider:
            typeof parsed.config.model_provider === 'string'
              ? parsed.config.model_provider
              : '',
          model_reasoning_effort: parsed.modelReasoningEffort ?? '',
        },
        'user',
        'codex-cli',
      )));
    } catch (error) {
      logger.warn(`[user-assets] skip Codex agent ${path}`, error);
    }
  }
  return assets;
}

function scanSkills(adapter: 'claude-code' | 'codex-cli'): AssetMeta[] {
  const root = join(
    adapter === 'claude-code' ? getClaudeConfigRoot() : getCodexHome(),
    'skills',
  );
  if (!safeIsDir(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    logger.warn(`[user-assets] cannot scan ${adapter} skills: ${root}`, error);
    return [];
  }
  const assets: AssetMeta[] = [];
  for (const entry of entries.sort()) {
    if (adapter === 'codex-cli' && entry === 'agent-deck') continue;
    if (adapter === 'claude-code' && hasClaudePluginManifest(join(root, entry))) continue;
    const path = join(root, entry, 'SKILL.md');
    if (!existsSync(path) || !safeIsFile(path)) continue;
    try {
      const frontmatter = parseFrontmatter(readFileSync(path, 'utf8'));
      const name = frontmatter.name?.trim() || entry;
      if (!isNativeAssetName(name)) continue;
      assets.push(asReadOnlyDirect(
        __metaBuilders.buildSkillMeta(name, path, frontmatter, 'user', adapter),
      ));
    } catch (error) {
      logger.warn(`[user-assets] skip ${adapter} skill ${path}`, error);
    }
  }
  return assets;
}

function asReadOnlyDirect(asset: AssetMeta): AssetMeta {
  return {
    ...asset,
    origin: 'direct',
    runtimeName: asset.name,
  };
}
