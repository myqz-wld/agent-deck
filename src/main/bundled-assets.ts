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
import { join } from 'node:path';
import { app } from 'electron';
import type { AssetMeta, BundledAssetsSnapshot } from '@shared/types';
import { ASSET_NAME_REGEX } from '@shared/types';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import { getClaudeAgentDeckPluginSourcePath } from './adapters/claude-code/sdk-injection';
import { getCodexAgentDeckPluginPath } from './adapters/codex-cli/codex-config-paths';
import { getGrokPluginRoot } from './adapters/grok-build/resources';
import { parseFrontmatter } from './utils/frontmatter';
import { substituteResourcesPlaceholder } from './utils/resources-placeholder';
import log from '@main/utils/logger';
import {
  getBundledAgentRuntimeOverride,
} from './bundled-agent-runtime-overrides';

const logger = log.scope('main-bundled-assets');

/** plan §P3 Step 3.3：bundled 资产 adapter narrowing key。user 资产此字段为 null。 */
export type BundledAdapter = 'claude-code' | 'codex-cli' | 'grok-build';

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
  const claudeRoot = getClaudeAgentDeckPluginSourcePath();
  const codexRoot = getCodexAgentDeckPluginPath();
  const grokRoot = getGrokPluginRoot();
  const snapshot: BundledAssetsSnapshot = {
    agents: [
      ...scanAgents(claudeRoot, 'claude-code'),
      ...scanAgents(codexRoot, 'codex-cli'),
      ...scanAgents(grokRoot, 'grok-build'),
    ].sort(compareAdapterThenName),
    skills: [
      ...scanSkills(claudeRoot, 'claude-code'),
      ...scanSkills(codexRoot, 'codex-cli'),
      ...scanSkills(grokRoot, 'grok-build'),
    ].sort(compareAdapterThenName),
  };
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
  const path = getBundledAssetPath(kind, name, adapter);
  if (!path) return { ok: false, reason: `not found: ${adapter}/${kind}/${name}` };
  try {
    const raw = readFileSync(path, 'utf8');
    return { ok: true, content: substituteResourcesPlaceholder(raw) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
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
  if (!isSafeName(name)) return null;
  const root =
    adapter === 'claude-code'
      ? getClaudeAgentDeckPluginSourcePath()
      : adapter === 'codex-cli'
        ? getCodexAgentDeckPluginPath()
        : getGrokPluginRoot();
  const path = kind === 'agent' ? getBundledAgentPath(root, name, adapter) : join(root, 'skills', name, 'SKILL.md');
  return existsSync(path) ? path : null;
}

function scanAgents(root: string, adapter: BundledAdapter): AssetMeta[] {
  const dir = join(root, 'agents');
  if (!existsSync(dir)) return [];
  const out: AssetMeta[] = [];
  for (const file of readdirSync(dir)) {
    const absPath = join(dir, file);
    try {
      if (adapter === 'codex-cli' && file.endsWith('.toml')) {
        const parsed = parseCodexAgentToml(readFileSync(absPath, 'utf8'));
        const name = parsed.name ?? file.slice(0, -5);
        if (!isSafeName(name)) continue;
        out.push(buildAgentMeta(name, absPath, {
          description: parsed.description ?? '',
          model: parsed.model ?? '',
          model_reasoning_effort: parsed.modelReasoningEffort ?? '',
          model_provider:
            typeof parsed.config.model_provider === 'string'
              ? parsed.config.model_provider
              : '',
        }, 'bundled', adapter));
        continue;
      }
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (!isSafeName(name)) continue;
      const fm = parseFrontmatter(readFileSync(absPath, 'utf8'));
      out.push(buildAgentMeta(name, absPath, fm, 'bundled', adapter));
    } catch (err) {
      logger.warn(`[bundled-assets] skip agent ${adapter}/${file}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function getBundledAgentPath(root: string, name: string, adapter: BundledAdapter): string {
  const dir = join(root, 'agents');
  if (adapter === 'codex-cli') {
    const directToml = join(dir, `${name}.toml`);
    if (existsSync(directToml)) return directToml;
    const byTomlName = findCodexBundledAgentTomlByName(dir, name);
    if (byTomlName) return byTomlName;
  }
  return join(dir, `${name}.md`);
}

function findCodexBundledAgentTomlByName(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.toml')) continue;
    const absPath = join(dir, file);
    try {
      const parsed = parseCodexAgentToml(readFileSync(absPath, 'utf8'));
      if (parsed.name === name) return absPath;
    } catch {
      // scanAgents logs parse failures; path lookup stays quiet.
    }
  }
  return null;
}

function scanSkills(root: string, adapter: BundledAdapter): AssetMeta[] {
  const dir = join(root, 'skills');
  if (!existsSync(dir)) return [];
  const out: AssetMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!isSafeName(entry)) continue;
    const skillDir = join(dir, entry);
    if (!safeIsDir(skillDir)) continue;
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'));
      out.push(buildSkillMeta(entry, skillFile, fm, 'bundled', adapter));
    } catch (err) {
      logger.warn(`[bundled-assets] skip skill ${adapter}/${entry}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * plan §P3 Step 3.3 + plan assets-codex-user-and-ui-unify-20260521 §D7：buildAgentMeta /
 * buildSkillMeta `adapter` 参数收紧为 `'claude-code' | 'codex-cli'` 必填（null 删除）。
 *
 * - bundled 资产：传具体 adapter ('claude-code' / 'codex-cli'，narrow 到 plugin root)
 * - user 资产（user-assets.ts via `__metaBuilders`）：传具体 adapter（plan §D7 user 资产
 *   也按 adapter 派发到 ~/.claude/ 或 ~/.codex/，AssetMeta.adapter null 完全删除）
 *
 * qualifiedName 拼装：
 * - bundled: `agent-deck:<adapter>:<name>` —— 防双 root 同名 agent 冲突
 * - user:    `<name>` —— 不变（user 资产 qualifiedName 不带 adapter 后缀，UI 单 sub-tab
 *   filter 视图内 name 天然唯一，跨 sub-tab 同名也是合法独立两条 plan §不变量 #5）
 */
function buildAgentMeta(
  name: string,
  absPath: string,
  fm: Record<string, string>,
  source: 'bundled' | 'user',
  adapter: BundledAdapter,
): AssetMeta {
  const description = fm.description ?? '';
  return {
    kind: 'agent',
    source,
    adapter,
    name,
    qualifiedName: source === 'bundled' ? `agent-deck:${adapter}:${name}` : name,
    description,
    tools: fm.tools,
    model: fm.model,
    thinking: fm.effort || fm.model_reasoning_effort || undefined,
    provider: adapter === 'codex-cli' ? fm.model_provider || undefined : undefined,
    absPath,
  };
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

function buildSkillMeta(
  name: string,
  absPath: string,
  fm: Record<string, string>,
  source: 'bundled' | 'user',
  adapter: BundledAdapter,
): AssetMeta {
  const description = fm.description ?? '';
  return {
    kind: 'skill',
    source,
    adapter,
    name,
    qualifiedName: source === 'bundled' ? `agent-deck:${adapter}:${name}` : name,
    description,
    absPath,
  };
}

/** 共享给 user-assets.ts：避免重复造轮子（agent/skill meta 拼装规则一致）。 */
export const __metaBuilders = { buildAgentMeta, buildSkillMeta };

/**
 * snapshot 排序：先 adapter（claude-code 排前 / codex-cli 排后），再 name。
 * AssetsLibraryDialog 单 section 内顺序稳定 + 跨 adapter 视觉分组（claude 资产成片 / codex 资产成片）。
 *
 * **plan assets-codex-user-and-ui-unify-20260521 §D7**：AssetMeta.adapter 类型已收紧为
 * `'claude-code' | 'codex-cli'`（null 删除），以前 `as 'claude-code' | 'codex-cli'` defensive
 * narrow 不再需要 — 直接读 a.adapter / b.adapter 即可。
 */
function compareAdapterThenName(a: AssetMeta, b: AssetMeta): number {
  const adapterRank = (x: BundledAdapter): number =>
    x === 'claude-code' ? 0 : x === 'codex-cli' ? 1 : 2;
  const ra = adapterRank(a.adapter);
  const rb = adapterRank(b.adapter);
  if (ra !== rb) return ra - rb;
  return a.name.localeCompare(b.name);
}

/**
 * 校验 asset name 安全：
 * - slug 见 `ASSET_NAME_REGEX`（首字符 a-z/0-9，后续 a-z/0-9/-）
 * - 长度 1-64
 * - 不含 `..` / 路径分隔符 / 隐藏前缀（regex 自带兜底）
 *
 * 跨进程共享单点真值（CHANGELOG_57 R1·F8 收口）：渲染端 `AssetEditor.tsx` 与 IPC 入参
 * `ipc/assets.ts` 都引 `ASSET_NAME_REGEX` 同款 regex；任何「错误信息 / 注释里写错 regex 字面量」
 * 的现象就被消除（F9）。
 */
export function isSafeName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 64) return false;
  return ASSET_NAME_REGEX.test(name);
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
