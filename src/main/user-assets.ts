/**
 * 用户自定义 agents/skills 管理（CHANGELOG_57 C2 / plan assets-codex-user-and-ui-unify-20260521
 * §D2 §D3 §D7 双 adapter user 自定义补齐）。
 *
 * 数据源：双 adapter root scan
 *   - **claude-code**:
 *     - `~/.claude/agents/<name>.md`        —— frontmatter: name/description/tools/model + body
 *     - `~/.claude/skills/<name>/SKILL.md`  —— frontmatter: name/description + body
 *   - **codex-cli**（plan §D2 user 平级 path，spike4 已铁证 OpenAI 自动加载）:
 *     - `~/.codex/skills/<name>/SKILL.md`   —— 与 bundled `~/.codex/skills/agent-deck/<X>/SKILL.md`
 *       同级不冲突；`scanUserSkills(codex)` skip `agent-deck/` 子目录是 defense in depth
 *     - **agents 不支持** —— codex CLI 无 user agent 概念（OpenAI 文档 + spike4 实证），
 *       `scanUserAgents('codex-cli')` 直接返 []，不扫 ~/.codex/agents/
 *
 * 这两条 claude 路径与 SDK 的 `settingSources: ['user', 'project', 'local']` 加载约定一致；
 * codex 路径由 codex CLI 自身扫描机制识别。应用只是提供可视化编辑器（list/save/delete/reveal），
 * 不做注入逻辑——文件落盘后下次新建 SDK 会话自动可见，与运行中的会话无关（codex CLI in-memory
 * cache 残留场景见 plan §已知踩坑 §8，UI 层加 toast 提示用户 restart）。
 *
 * 写盘走原子写（write tmp + rename），与 sdk-injection.ts 的 saveUserAgentDeckClaudeMd 同模式
 * （REVIEW_2 教训：直接覆盖写在崩溃 / 磁盘满时会留半截文件，被 SDK 当生效注入）。
 *
 * **plan §D3 不变量 #4 codex+agent 硬拒**：所有 user-asset 操作（save / get / delete / path）
 * 在 codex-cli + agent 组合时调 `validateAdapterKind` helper 立即 return reject，与 ipc/assets.ts
 * IPC 层校验形成双层防线。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AssetMeta, UserAssetInput, UserAssetsSnapshot } from '@shared/types';
import { validateAdapterKind } from '@shared/types';
import { __metaBuilders, isSafeName } from './bundled-assets';
import { parseFrontmatter, stringifyFrontmatter } from './utils/frontmatter';
import log from '@main/utils/logger';

const logger = log.scope('main-user-assets');

type UserAdapter = 'claude-code' | 'codex-cli';

// claude-code root（与 SDK settingSources: ['user', ...] 加载一致）
const USER_CLAUDE_ROOT = join(homedir(), '.claude');
const USER_CLAUDE_AGENTS_DIR = join(USER_CLAUDE_ROOT, 'agents');
const USER_CLAUDE_SKILLS_DIR = join(USER_CLAUDE_ROOT, 'skills');

// codex-cli root（plan §D2 user 平级，spike4 实证 OpenAI 自动加载 ~/.codex/skills/<name>/SKILL.md）
// **不加 USER_CODEX_AGENTS_DIR**：codex CLI 无 user agent 概念（plan §D3 / 不变量 #4），
// `scanUserAgents('codex-cli')` 直接返 [] 不扫该路径
const USER_CODEX_ROOT = join(homedir(), '.codex');
const USER_CODEX_SKILLS_DIR = join(USER_CODEX_ROOT, 'skills');

/**
 * 列出用户自定义 agents/skills；目录不存在视为空清单。每次现扫现读（CRUD 完即时反映）。
 *
 * **plan §D7**：双 adapter root scan，3 次扫描合并：
 * - claude-code agents（~/.claude/agents/）
 * - claude-code skills（~/.claude/skills/）
 * - codex-cli skills（~/.codex/skills/，skip `agent-deck/` 子目录）
 * - codex-cli agents：跳过（不变量 #4）
 *
 * **root-level partial snapshot fallback**（plan §不变量 + reviewer-codex LOW-D）:
 * 每个 scan 函数内部 readdirSync(root) 异常时 console.warn + return [] 不抛错，让 codex root
 * 不可读 / EACCES / 跨 fs 时 claude root assets 仍能展示（不让一个 root 失败拖垮整个 list）。
 */
export function listUserAssets(): UserAssetsSnapshot {
  return {
    agents: scanUserAgents('claude-code'),
    skills: [
      ...scanUserSkills('claude-code'),
      ...scanUserSkills('codex-cli'),
    ],
  };
}

/**
 * 读单个用户 asset 完整文件文本（含 frontmatter + body），编辑器 mount 用。
 *
 * **plan §D7 升级**：adapter 必传，按 adapter narrow 派发到对应 root；codex+agent 组合 reject。
 */
export function getUserAssetContent(
  kind: 'agent' | 'skill',
  name: string,
  adapter: UserAdapter,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (!isSafeName(name)) return { ok: false, reason: `name 非法（需匹配 ASSET_NAME_REGEX）：${name}` };
  const valid = validateAdapterKind(adapter, kind);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  const path = getUserAssetPath(kind, name, adapter);
  if (!path) return { ok: false, reason: `not found: ${adapter}/${kind}/${name}` };
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * 返回用户 asset 的绝对路径，给 shell.showItemInFolder 用。不存在返回 null。
 *
 * **plan §D7 升级**：按 adapter narrow 派发；codex+agent 组合直接返 null（path 不存在概念）。
 */
export function getUserAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  adapter: UserAdapter,
): string | null {
  if (!isSafeName(name)) return null;
  if (!validateAdapterKind(adapter, kind).ok) return null;
  const path = resolveUserAssetPath(kind, name, adapter);
  return path && existsSync(path) ? path : null;
}

/**
 * 解析 user asset 目标路径（不检查 existsSync，让 caller 决定是返 null 还是 mkdir 写新）。
 *
 * 路径表（plan §D2 §D3）：
 * - claude-code agent → ~/.claude/agents/<name>.md
 * - claude-code skill → ~/.claude/skills/<name>/SKILL.md
 * - codex-cli  agent → null（codex 无 user agent，validateAdapterKind 已拒）
 * - codex-cli  skill → ~/.codex/skills/<name>/SKILL.md
 */
function resolveUserAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  adapter: UserAdapter,
): string | null {
  if (adapter === 'claude-code') {
    return kind === 'agent'
      ? join(USER_CLAUDE_AGENTS_DIR, `${name}.md`)
      : join(USER_CLAUDE_SKILLS_DIR, name, 'SKILL.md');
  }
  // codex-cli
  if (kind === 'agent') return null; // 不变量 #4
  return join(USER_CODEX_SKILLS_DIR, name, 'SKILL.md');
}

/**
 * 保存用户 asset：拼装 frontmatter + 原子写盘。
 *
 * - claude-code skills → `~/.claude/skills/<name>/SKILL.md`（自动 mkdir 子目录）
 * - claude-code agents → `~/.claude/agents/<name>.md`（mkdir agents 目录）
 * - codex-cli  skills → `~/.codex/skills/<name>/SKILL.md`（同款，spike4 实证 OpenAI 自动加载）
 * - codex-cli  agents → reject（plan §D3 不变量 #4，IPC 层 + main 层双拒）
 *
 * 校验：
 * - input.adapter + input.kind 通过 validateAdapterKind（codex+agent reject）
 * - name 通过 isSafeName（slug `[a-z0-9-]+`，长度 1-64）
 * - description 必填非空
 * - agent: model 必填（避免无 model agent 起 SDK 报错）
 *
 * 失败返回 `{ ok: false, reason }`，由 IPC handler 透传给 renderer 显示。
 *
 * 原子写：write tmp + rename，与 sdk-injection.ts:151-159 saveUserAgentDeckClaudeMd 同模式。
 * **finally 删 tmp**（CHANGELOG_57 R1·F10）：renameSync 抛错后 try/finally 兜底删 .tmp.PID
 * 残留，避免 user dir ls 看到一堆奇怪 tmp 文件（虽然不污染 SDK 加载——scan 函数过滤 .md 后缀）。
 */
export function saveUserAsset(input: UserAssetInput): { ok: true } | { ok: false; reason: string } {
  const valid = validateAdapterKind(input.adapter, input.kind);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  if (!isSafeName(input.name)) {
    return { ok: false, reason: `name 非法（需匹配 ASSET_NAME_REGEX，长度 1-64）：${input.name}` };
  }
  const description = (input.description ?? '').trim();
  if (description.length === 0) {
    return { ok: false, reason: 'description 必填非空' };
  }
  if (input.kind === 'agent') {
    const model = (input.model ?? '').trim();
    if (model.length === 0) return { ok: false, reason: 'agent 必填 model 字段' };
  }

  const targetPath = resolveUserAssetPath(input.kind, input.name, input.adapter);
  if (!targetPath) {
    // 防御性：validateAdapterKind 已拒 codex+agent，这里 resolveUserAssetPath 返 null 唯一路径
    return { ok: false, reason: 'unsupported adapter+kind combination (defense in depth)' };
  }

  const fm: Record<string, string> = { name: input.name, description };
  if (input.kind === 'agent') {
    if (input.tools !== undefined && input.tools.trim().length > 0) fm.tools = input.tools.trim();
    if (input.model !== undefined && input.model.trim().length > 0) fm.model = input.model.trim();
  }
  const body = (input.body ?? '').replace(/\r\n/g, '\n');
  const fileText = `${stringifyFrontmatter(fm)}\n${body}${body.endsWith('\n') ? '' : '\n'}`;

  const tmp = `${targetPath}.tmp.${process.pid}`;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(tmp, fileText, 'utf8');
    renameSync(tmp, targetPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    // 兜底清理 tmp（renameSync 失败 / mkdirSync 之间崩溃都可能留）
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 删 tmp 失败不抛错——主操作的成功/失败结果已 return */
    }
  }
}

/**
 * 删除用户 asset：
 * - skill 是子目录（含 SKILL.md + 可能其他附件如 scripts/），rmSync recursive
 * - agent 是单文件，unlinkSync
 *
 * 不存在视为成功（幂等，UI 删了刷新看到没了符合预期）。
 *
 * **plan §D7 升级**：adapter 必传，按 adapter narrow 派发；codex+agent 组合 reject。
 *
 * **plan §不变量 #5 同名跨 adapter 独立**：deleteUserAsset(kind, name, 'codex-cli') 只删 codex
 * root 同名资产，claude root 同名资产不动（root scope 隔离）。
 *
 * **拒删 symlink / junction**（CHANGELOG_57 R1·Q1 兜底）：lstatSync 检查目标本身（不 follow），
 * 若是 symlink / Win NTFS junction 直接拒绝，要求用户在文件管理器手动处理。
 * 用户自己往自己 home 放 symlink 不属跨边界攻击，但 rmSync recursive force 在 Win 上对 junction
 * 的行为未验证；保守拒删可避免跨平台变种破坏（user 看到错误信息能去 Finder/资源管理器人工删）。
 */
export function deleteUserAsset(
  kind: 'agent' | 'skill',
  name: string,
  adapter: UserAdapter,
): { ok: true } | { ok: false; reason: string } {
  const valid = validateAdapterKind(adapter, kind);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  if (!isSafeName(name)) return { ok: false, reason: `name 非法（需匹配 ASSET_NAME_REGEX）：${name}` };
  try {
    if (kind === 'agent') {
      // adapter 必为 'claude-code'（codex+agent 已被 validateAdapterKind 拒）
      const path = join(USER_CLAUDE_AGENTS_DIR, `${name}.md`);
      if (!existsSync(path)) return { ok: true };
      const lst = lstatSync(path);
      if (lst.isSymbolicLink()) {
        return { ok: false, reason: 'agent 是 symlink，请在文件管理器手动删除' };
      }
      unlinkSync(path);
    } else {
      // skill：按 adapter narrow root
      const skillsRoot = adapter === 'claude-code' ? USER_CLAUDE_SKILLS_DIR : USER_CODEX_SKILLS_DIR;
      const dir = join(skillsRoot, name);
      if (!existsSync(dir)) return { ok: true };
      const lst = lstatSync(dir);
      if (lst.isSymbolicLink()) {
        return { ok: false, reason: 'skill 目录是 symlink，请在文件管理器手动删除' };
      }
      rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Scan claude-code user agents（~/.claude/agents/<name>.md）。
 *
 * **plan §D3 不变量 #4**：codex-cli adapter 直接返 [] 不扫 ~/.codex/agents/
 * （codex CLI 无 user agent 概念，扫了也是 dead code）。
 *
 * **root-level fallback**（reviewer-codex LOW-D）：readdirSync 抛错时 console.warn + return []，
 * 让上层 listUserAssets 仍能 partial snapshot（claude root 不可读时不拖垮 codex root list）。
 */
function scanUserAgents(adapter: UserAdapter): AssetMeta[] {
  if (adapter === 'codex-cli') return []; // 不变量 #4
  if (!existsSync(USER_CLAUDE_AGENTS_DIR)) return [];
  let entries: string[];
  try {
    entries = readdirSync(USER_CLAUDE_AGENTS_DIR);
  } catch (err) {
    logger.warn(`[user-assets] scanUserAgents readdir failed: ${USER_CLAUDE_AGENTS_DIR}`, err);
    return [];
  }
  const out: AssetMeta[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (!isSafeName(name)) continue;
    const absPath = join(USER_CLAUDE_AGENTS_DIR, file);
    try {
      const fm = parseFrontmatter(readFileSync(absPath, 'utf8'));
      out.push(__metaBuilders.buildAgentMeta(name, absPath, fm, 'user', 'claude-code'));
    } catch (err) {
      logger.warn(`[user-assets] skip agent ${name}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scan user skills（按 adapter narrow root）：
 * - claude-code → `~/.claude/skills/<name>/SKILL.md`
 * - codex-cli → `~/.codex/skills/<name>/SKILL.md`（skip `agent-deck/` 子目录是 defense in depth，
 *   bundled 落 ~/.codex/skills/agent-deck/<X>/SKILL.md 嵌套两层不会被扫识别 — 现有扫描天然过滤）
 *
 * **root-level fallback**（reviewer-codex LOW-D）：readdirSync 抛错时 console.warn + return []。
 */
function scanUserSkills(adapter: UserAdapter): AssetMeta[] {
  const skillsRoot = adapter === 'claude-code' ? USER_CLAUDE_SKILLS_DIR : USER_CODEX_SKILLS_DIR;
  if (!existsSync(skillsRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch (err) {
    logger.warn(`[user-assets] scanUserSkills readdir failed: ${skillsRoot}`, err);
    return [];
  }
  const out: AssetMeta[] = [];
  for (const entry of entries) {
    // codex root 显式 skip `agent-deck/` plugin 子目录（plan §不变量 #1 defense in depth；
    // bundled SSOT 由 syncSkills() 写到该子目录，与 user 平级 ~/.codex/skills/<name>/ 不撞名）
    if (adapter === 'codex-cli' && entry === 'agent-deck') continue;
    if (!isSafeName(entry)) continue;
    const skillDir = join(skillsRoot, entry);
    if (!safeIsDir(skillDir)) continue;
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'));
      out.push(__metaBuilders.buildSkillMeta(entry, skillFile, fm, 'user', adapter));
    } catch (err) {
      logger.warn(`[user-assets] skip skill ${adapter}/${entry}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
