/**
 * agent-deck plugin 内置 agents/skills 元数据扫描与缓存（CHANGELOG_57 C2）。
 *
 * 数据源：`getClaudeAgentDeckPluginPath()` 下的两个子目录
 *   - `agents/<name>.md`        —— frontmatter: name/description/tools/model
 *   - `skills/<name>/SKILL.md`  —— frontmatter: name/description
 *
 * 启动时一次性扫描全部、解析 frontmatter（手写正则，避免引 YAML 依赖——4 个字段、
 * 单行 key:value 模式足够）、缓存到模块级 module variable。`AssetsListBundled` IPC
 * handler 直接读缓存零开销。读单个文件原文（「查看完整内容」/编辑器打开）走
 * `getBundledAssetContent` 现读，避免长文本 + 多文件常驻内存。
 *
 * 路径分流：dev `<repo>/resources/claude-config/agent-deck-plugin/`，
 * prod `<resourcesPath>/claude-config/agent-deck-plugin/`，由 sdk-injection.ts 复用。
 *
 * **plan §P3 Step 3.2 起 claude 路径解析改名 `getClaudeAgentDeckPluginPath`**（双 root
 * 多 adapter scan 在 Step 3.3 落地；本 Step 仅 rename caller，行为零变化）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AssetMeta, BundledAssetsSnapshot } from '@shared/types';
import { ASSET_NAME_REGEX } from '@shared/types';
import { getClaudeAgentDeckPluginPath } from './adapters/claude-code/sdk-injection';
import { parseFrontmatter } from './utils/frontmatter';

let cached: BundledAssetsSnapshot | null = null;

/**
 * main 启动时调一次（在 bootstrapIpc 之前），让 IPC handler 直接读缓存。
 *
 * Dev / packaged 缓存策略不同（CHANGELOG_57 R1·F11 收口）：
 * - **packaged**：`process.resourcesPath/claude-config/` 是 read-only 资源，cache 永久有效
 * - **dev (`!app.isPackaged`)**：每次调都重扫，让开发者改 plugin md 后立刻在「资产库」里看到新 frontmatter，
 *   不必重启 Electron。代价：每次 mount AssetsLibraryDialog 重扫 ~4 文件 frontmatter（毫秒级）。
 */
export function loadBundledAssets(): BundledAssetsSnapshot {
  if (cached && app.isPackaged) return cached;
  const root = getClaudeAgentDeckPluginPath();
  const snapshot: BundledAssetsSnapshot = {
    agents: scanAgents(root),
    skills: scanSkills(root),
  };
  if (app.isPackaged) cached = snapshot;
  return snapshot;
}

export function getBundledAssets(): BundledAssetsSnapshot {
  return loadBundledAssets();
}

/** 读单个 bundled asset 完整文件文本（含 frontmatter + body）。 */
export function getBundledAssetContent(
  kind: 'agent' | 'skill',
  name: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const path = getBundledAssetPath(kind, name);
  if (!path) return { ok: false, reason: `not found: ${kind}/${name}` };
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 返回 bundled asset 的绝对路径，给 shell.showItemInFolder 用。 */
export function getBundledAssetPath(kind: 'agent' | 'skill', name: string): string | null {
  if (!isSafeName(name)) return null;
  const root = getClaudeAgentDeckPluginPath();
  const path = kind === 'agent' ? join(root, 'agents', `${name}.md`) : join(root, 'skills', name, 'SKILL.md');
  return existsSync(path) ? path : null;
}

function scanAgents(root: string): AssetMeta[] {
  const dir = join(root, 'agents');
  if (!existsSync(dir)) return [];
  const out: AssetMeta[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (!isSafeName(name)) continue;
    const absPath = join(dir, file);
    try {
      const fm = parseFrontmatter(readFileSync(absPath, 'utf8'));
      out.push(buildAgentMeta(name, absPath, fm, 'bundled'));
    } catch (err) {
      console.warn(`[bundled-assets] skip agent ${name}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function scanSkills(root: string): AssetMeta[] {
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
      out.push(buildSkillMeta(entry, skillFile, fm, 'bundled'));
    } catch (err) {
      console.warn(`[bundled-assets] skip skill ${entry}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function buildAgentMeta(
  name: string,
  absPath: string,
  fm: Record<string, string>,
  source: 'bundled' | 'user',
): AssetMeta {
  const description = fm.description ?? '';
  return {
    kind: 'agent',
    source,
    name,
    qualifiedName: source === 'bundled' ? `agent-deck:${name}` : name,
    description,
    tools: fm.tools,
    model: fm.model,
    triggers: extractTriggers(description),
    absPath,
  };
}

function buildSkillMeta(
  name: string,
  absPath: string,
  fm: Record<string, string>,
  source: 'bundled' | 'user',
): AssetMeta {
  const description = fm.description ?? '';
  return {
    kind: 'skill',
    source,
    name,
    qualifiedName: source === 'bundled' ? `agent-deck:${name}` : name,
    description,
    triggers: extractTriggers(description),
    absPath,
  };
}

/** 共享给 user-assets.ts：避免重复造轮子（agent/skill meta 拼装规则一致）。 */
export const __metaBuilders = { buildAgentMeta, buildSkillMeta };

/**
 * 从 description 文本里抽出「触发：xxx」/「/agent-deck:xxx」短语，给 UI 显示「触发关键词」。
 * 简化：只抽 `/<plugin>:<skill>` 形态的 slash command 引用，最多 5 条。
 */
function extractTriggers(description: string): string[] | undefined {
  const set = new Set<string>();
  const re = /\/[a-z0-9-]+:[a-z0-9-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    set.add(m[0]);
    if (set.size >= 5) break;
  }
  return set.size > 0 ? Array.from(set) : undefined;
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
