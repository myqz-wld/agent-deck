import type { AssetMeta, AssetSource, BundledAssetsSnapshot } from '@shared/types/assets';
import { ASSET_NAME_REGEX } from '@shared/types/assets';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import { join } from 'node:path';
import { parseFrontmatter } from './utils/frontmatter';

export type BundledAdapter = 'claude-code' | 'codex-cli' | 'grok-build';

export interface BundledAssetSource {
  adapter: BundledAdapter;
  root: string;
}

export interface BundledAssetStoreFilesystem {
  existsSync: typeof import('node:fs').existsSync;
  readdirSync: typeof import('node:fs').readdirSync;
  readFileSync: typeof import('node:fs').readFileSync;
  statSync: typeof import('node:fs').statSync;
}

export interface BundledAssetScanWarning {
  adapter: BundledAdapter;
  entry: string;
  kind: 'agent' | 'skill';
  reason: string;
}

export function scanBundledAssets(
  sources: readonly BundledAssetSource[],
  filesystem: BundledAssetStoreFilesystem,
  warn?: (warning: BundledAssetScanWarning) => void,
): BundledAssetsSnapshot {
  return {
    agents: sources
      .flatMap(({ root, adapter }) => scanAgents(root, adapter, filesystem, warn))
      .sort(compareAdapterThenName),
    skills: sources
      .flatMap(({ root, adapter }) => scanSkills(root, adapter, filesystem, warn))
      .sort(compareAdapterThenName),
  };
}

export function readBundledAssetContent(
  root: string,
  kind: 'agent' | 'skill',
  name: string,
  adapter: BundledAdapter,
  filesystem: BundledAssetStoreFilesystem,
): { ok: true; content: string } | { ok: false; reason: string } {
  const path = resolveBundledAssetPath(root, kind, name, adapter, filesystem);
  if (!path) return { ok: false, reason: `not found: ${adapter}/${kind}/${name}` };
  try {
    return { ok: true, content: filesystem.readFileSync(path, 'utf8') };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export function resolveBundledAssetPath(
  root: string,
  kind: 'agent' | 'skill',
  name: string,
  adapter: BundledAdapter,
  filesystem: Pick<BundledAssetStoreFilesystem, 'existsSync'>,
): string | null {
  if (!isSafeName(name)) return null;
  const path = kind === 'agent'
    ? getBundledAgentPath(root, name, adapter)
    : join(root, 'skills', name, 'SKILL.md');
  return filesystem.existsSync(path) ? path : null;
}

function scanAgents(
  root: string,
  adapter: BundledAdapter,
  filesystem: BundledAssetStoreFilesystem,
  warn?: (warning: BundledAssetScanWarning) => void,
): AssetMeta[] {
  const dir = join(root, 'agents');
  if (!filesystem.existsSync(dir)) return [];
  const assets: AssetMeta[] = [];
  for (const file of filesystem.readdirSync(dir)) {
    const absPath = join(dir, file);
    try {
      if (adapter === 'codex-cli' && file.endsWith('.toml')) {
        const parsed = parseCodexAgentToml(filesystem.readFileSync(absPath, 'utf8'));
        const name = file.slice(0, -5);
        if (parsed.name !== name) {
          throw new Error(
            `bundled Codex Agent name must match filename: ${parsed.name ?? '<missing>'} != ${name}`,
          );
        }
        if (!isSafeName(name)) continue;
        assets.push(buildAgentMeta(name, absPath, {
          description: parsed.description ?? '',
          model: parsed.model ?? '',
          model_provider:
            typeof parsed.config.model_provider === 'string'
              ? parsed.config.model_provider
              : '',
          model_reasoning_effort: parsed.modelReasoningEffort ?? '',
        }, 'bundled', adapter));
        continue;
      }
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (!isSafeName(name)) continue;
      const frontmatter = parseFrontmatter(filesystem.readFileSync(absPath, 'utf8'));
      assets.push(buildAgentMeta(name, absPath, frontmatter, 'bundled', adapter));
    } catch (error) {
      warn?.({ adapter, entry: file, kind: 'agent', reason: errorMessage(error) });
    }
  }
  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

function scanSkills(
  root: string,
  adapter: BundledAdapter,
  filesystem: BundledAssetStoreFilesystem,
  warn?: (warning: BundledAssetScanWarning) => void,
): AssetMeta[] {
  const dir = join(root, 'skills');
  if (!filesystem.existsSync(dir)) return [];
  const assets: AssetMeta[] = [];
  for (const entry of filesystem.readdirSync(dir)) {
    if (!isSafeName(entry)) continue;
    const skillDir = join(dir, entry);
    if (!safeIsDirectory(skillDir, filesystem)) continue;
    const skillFile = join(skillDir, 'SKILL.md');
    if (!filesystem.existsSync(skillFile)) continue;
    try {
      const frontmatter = parseFrontmatter(filesystem.readFileSync(skillFile, 'utf8'));
      assets.push(buildSkillMeta(entry, skillFile, frontmatter, 'bundled', adapter));
    } catch (error) {
      warn?.({ adapter, entry, kind: 'skill', reason: errorMessage(error) });
    }
  }
  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

function getBundledAgentPath(
  root: string,
  name: string,
  adapter: BundledAdapter,
): string {
  return join(root, 'agents', `${name}.${adapter === 'codex-cli' ? 'toml' : 'md'}`);
}

export function buildAgentMeta(
  name: string,
  absPath: string,
  frontmatter: Record<string, string>,
  source: AssetSource,
  adapter: BundledAdapter,
): AssetMeta {
  return {
    kind: 'agent',
    source,
    adapter,
    name,
    qualifiedName: source === 'bundled' ? `agent-deck:${adapter}:${name}` : name,
    description: frontmatter.description ?? '',
    tools: frontmatter.tools,
    model: frontmatter.model,
    thinking:
      adapter === 'codex-cli'
        ? frontmatter.model_reasoning_effort || undefined
        : frontmatter.effort || undefined,
    provider:
      adapter === 'claude-code'
        ? frontmatter.gateway || undefined
        : adapter === 'codex-cli'
          ? frontmatter.model_provider || undefined
          : undefined,
    absPath,
  };
}

export function buildSkillMeta(
  name: string,
  absPath: string,
  frontmatter: Record<string, string>,
  source: AssetSource,
  adapter: BundledAdapter,
): AssetMeta {
  return {
    kind: 'skill',
    source,
    adapter,
    name,
    qualifiedName: source === 'bundled' ? `agent-deck:${adapter}:${name}` : name,
    description: frontmatter.description ?? '',
    absPath,
  };
}

export function isSafeName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    ASSET_NAME_REGEX.test(name)
  );
}

function compareAdapterThenName(left: AssetMeta, right: AssetMeta): number {
  const rank = (adapter: BundledAdapter): number =>
    adapter === 'claude-code' ? 0 : adapter === 'codex-cli' ? 1 : 2;
  return rank(left.adapter) - rank(right.adapter) || left.name.localeCompare(right.name);
}

function safeIsDirectory(
  path: string,
  filesystem: Pick<BundledAssetStoreFilesystem, 'statSync'>,
): boolean {
  try {
    return filesystem.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
