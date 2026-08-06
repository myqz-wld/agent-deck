/**
 * agent-deck plugin 内置 agents/skills 元数据扫描与缓存（CHANGELOG_57 C2 / plan
 * codex-handoff-team-alignment-20260518 §P3 Step 3.3 multi-adapter）。
 *
 * 数据源：三 root scan
 *   - claude-code root: `getClaudeAgentDeckPluginSourcePath()` → `resources/claude-config/agent-deck-plugin/`
 *   - codex-cli  root: `getCodexAgentDeckPluginPath()`  → `resources/codex-config/agent-deck-plugin/`
 *   - grok-build root: `getGrokPluginRoot()` → `resources/grok-config/agent-deck-plugin/`
 *
 * 各 root 下两个子目录：
 *   - Claude agents: `agents/<name>.md` —— frontmatter: name/description/tools/model/effort
 *   - Codex agents: `agents/<name>.toml` —— official Codex custom-agent TOML
 *   - `skills/<name>/SKILL.md`  —— frontmatter: name/description
 *
 * 启动时一次性扫描三个 root、合并到同一 snapshot、解析 frontmatter（手写正则，避免引
 * YAML 依赖——4 个字段、单行 key:value 模式足够）、缓存到模块级 module variable。
 * `AssetsListBundled` IPC handler 直接读缓存零开销。读单个文件原文（「查看完整内容」/编辑器
 * 打开）走 `getBundledAssetContent(kind, name, adapter)` 现读，避免长文本 + 多文件常驻内存。
 *
 * **adapter narrowing**（plan §P3 Step 3.3 关键修法）：
 * - bundled 同名资产可能在多个 root 各有一份内容不同的版本（如 reviewer-claude wrapper 在 claude
 *   视角是 SDK teammate 直接跑 / 在 codex 视角是 Bash spawn 外部 claude CLI）。`getBundledAssetContent`
 *   / `getBundledAssetPath` 必须显式传 adapter narrow 到具体 root，不能 fallback 任意一边。
 * - qualifiedName：`agent-deck:<adapter>:<name>`
 *   防同名冲突；user 资产 qualifiedName 不变（`<name>`）。
 *
 * 路径分流：dev `<repo>/resources/<adapter>-config/agent-deck-plugin/`，prod
 * `<resourcesPath>/<adapter>-config/agent-deck-plugin/`，由 sdk-injection.ts (claude) /
 * codex-config-paths.ts (codex) 与 Grok resources helper 各自实现 dev/prod 路径解析；本文件
 * 直接 import 具体 helper，各自扫描 provider root（扫描内部已知 adapter，不需 dispatcher —
 * P5 Round 1 reviewer-claude MED 修法已删 agent-deck-plugin-paths.ts dispatcher 死代码，
 * 0 production caller，违反 user CLAUDE.md §提示词资产维护 约束 2「不写预测未来用例代码」）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { app } from 'electron';
import type { AssetMeta, BundledAssetsSnapshot } from '@shared/types';
import { getClaudeAgentDeckPluginSourcePath } from './adapters/claude-code/sdk-injection';
import { getCodexAgentDeckPluginPath } from './adapters/codex-cli/codex-config-paths';
import { getGrokPluginRoot } from './adapters/grok-build/resources';
import { substituteResourcesPlaceholder } from './utils/resources-placeholder';
import log from '@main/utils/logger';
import {
  buildAgentMeta,
  buildSkillMeta,
  readBundledAssetContent,
  resolveBundledAssetPath,
  scanBundledAssets,
  type BundledAdapter,
  type BundledAssetScanWarning,
  type BundledAssetStoreFilesystem,
} from './bundled-asset-store';
import {
  getBundledAgentRuntimeOverride,
} from './bundled-agent-runtime-overrides';

const logger = log.scope('main-bundled-assets');

/** plan §P3 Step 3.3：bundled 资产 adapter narrowing key。user 资产此字段为 null。 */
export type { BundledAdapter } from './bundled-asset-store';
export { isSafeName } from './bundled-asset-store';

const bundledAssetFilesystem: BundledAssetStoreFilesystem = {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
};

let cached: BundledAssetsSnapshot | null = null;

/**
 * main 启动时调一次（在 bootstrapIpc 之前），让 IPC handler 直接读缓存。
 *
 * Dev / packaged 缓存策略不同（CHANGELOG_57 R1·F11 收口）：
 * - **packaged**：`process.resourcesPath/<adapter>-config/` 是 read-only 资源，cache 永久有效
 * - **dev (`!app.isPackaged`)**：每次调都重扫，让开发者改 plugin md 后立刻在「资产库」里看到
 *   新 frontmatter，不必重启 Electron。代价：每次 mount AssetsLibraryDialog 重扫三个 root
 *   ~8 文件 frontmatter（毫秒级）。
 *
 * **多 root 合并**：claude-code、codex-cli 与 grok-build root 各自扫描，
 * agents / skills 数组合并；同 kind 同 name 跨 root 不去重（由 adapter 字段区分）。snapshot
 * 内部 sort 按 (adapter asc, name asc)，UI 渲染顺序稳定。
 */
export function loadBundledAssets(): BundledAssetsSnapshot {
  if (cached && app.isPackaged) return cached;
  const snapshot = scanBundledAssets([
    { root: getClaudeAgentDeckPluginSourcePath(), adapter: 'claude-code' },
    { root: getCodexAgentDeckPluginPath(), adapter: 'codex-cli' },
    { root: getGrokPluginRoot(), adapter: 'grok-build' },
  ], bundledAssetFilesystem, warnOnScanFailure);
  if (app.isPackaged) cached = snapshot;
  return snapshot;
}

export function getBundledAssets(): BundledAssetsSnapshot {
  const snapshot = loadBundledAssets();
  return {
    agents: snapshot.agents.map(applyBundledAgentRuntimeOverride),
    skills: snapshot.skills,
  };
}

/**
 * 读单个 bundled asset 完整文件文本（含 frontmatter + body）。
 *
 * **plan §P3 Step 3.3 breaking change**：必传 `adapter`。同 kind/name 跨 adapter 内容
 * 完全不同（如 reviewer-claude wrapper），无 fallback —— 不传 adapter 没法定位 fs 路径。
 * caller 通过 `AssetMeta.adapter` 字段或 args.adapter 拿到。
 *
 * Codex 侧通过 `getCodexAgentDeckPluginPath()` 直接返 SOURCE 路径（无 mirror），与 claude 侧
 * plugin-mirror-install 不对称。spawn_session 解析 bundled Codex TOML 后通过 app-server
 * developerInstructions/config 注入；如果未来 bundled agent body 内含
 * `{{AGENT_DECK_RESOURCES}}` placeholder（即使现在干净），这里在 read 出口集中防御 substitute。
 */
export function getBundledAssetContent(
  kind: 'agent' | 'skill',
  name: string,
  adapter: BundledAdapter,
): { ok: true; content: string } | { ok: false; reason: string } {
  const result = readBundledAssetContent(
    getBundledRoot(adapter),
    kind,
    name,
    adapter,
    bundledAssetFilesystem,
  );
  return result.ok
    ? { ok: true, content: substituteResourcesPlaceholder(result.content) }
    : result;
}

/**
 * 返回 bundled asset 的绝对路径，给 shell.showItemInFolder 用。
 *
 * **plan §P3 Step 3.3 breaking change**：必传 `adapter` narrow 到具体 root。
 */
export function getBundledAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  adapter: BundledAdapter,
): string | null {
  return resolveBundledAssetPath(
    getBundledRoot(adapter),
    kind,
    name,
    adapter,
    bundledAssetFilesystem,
  );
}

function getBundledRoot(adapter: BundledAdapter): string {
  return adapter === 'claude-code'
    ? getClaudeAgentDeckPluginSourcePath()
    : adapter === 'codex-cli'
      ? getCodexAgentDeckPluginPath()
      : getGrokPluginRoot();
}

function warnOnScanFailure(warning: BundledAssetScanWarning): void {
  logger.warn(
    `[bundled-assets] skip ${warning.kind} ${warning.adapter}/${warning.entry}:`,
    warning.reason,
  );
}

function applyBundledAgentRuntimeOverride(asset: AssetMeta): AssetMeta {
  const defaults = {
    ...(asset.model ? { model: asset.model } : {}),
    ...(asset.thinking ? { thinking: asset.thinking } : {}),
    ...(asset.provider ? { provider: asset.provider } : {}),
  };
  const override = getBundledAgentRuntimeOverride(asset.adapter, asset.name);
  return {
    ...asset,
    model: override.model ?? defaults.model,
    thinking: override.thinking ?? defaults.thinking,
    provider: override.provider ?? defaults.provider,
    bundledAgentRuntime: { defaults, override },
  };
}

/** 共享给 user-assets.ts：避免重复造轮子（agent/skill meta 拼装规则一致）。 */
export const __metaBuilders = { buildAgentMeta, buildSkillMeta };
