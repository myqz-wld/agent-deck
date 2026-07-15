/**
 * 用户自定义 agents/skills 管理（CHANGELOG_57 C2 / plan assets-codex-user-and-ui-unify-20260521
 * §D2 §D3 §D7 双 adapter user 自定义补齐）。
 *
 * 数据源：双 adapter root scan
 *   - **claude-code**:
 *     - `~/.claude/agents/<name>.md`        —— frontmatter: name/description/tools/model + body
 *     - `~/.claude/skills/<name>/SKILL.md`  —— frontmatter: name/description + body
 *   - **codex-cli**:
 *     - `~/.codex/agents/<name>.toml`       —— official custom agent TOML; `name` is source of truth
 *     - `~/.codex/skills/<name>/SKILL.md`   —— user-managed skills; bundled Agent Deck skills are
 *       passed separately through app-server `skills/extraRoots/set`
 *
 * 这两条 claude 路径与 SDK 的 `settingSources: ['user', 'project', 'local']` 加载约定一致；
 * Codex agents are resolved by Agent Deck from bundled/project/user TOML and then mapped onto
 * app-server thread/config fields because the current app-server API has no direct `agentName`
 * selector. User skills remain native files under `~/.codex/skills`.
 *
 * 写盘走原子写（write tmp + rename），与 sdk-injection.ts 的 saveUserAgentDeckClaudeMd 同模式
 * （REVIEW_2 教训：直接覆盖写在崩溃 / 磁盘满时会留半截文件，被 SDK 当生效注入）。
 *
 * codex-cli + agent is now supported for official TOML custom agents.
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
import { parseCodexAgentToml, stringifyCodexAgentToml } from '@shared/codex-agent-toml';
import { __metaBuilders, isSafeName } from './bundled-assets';
import { parseFrontmatter, stringifyFrontmatter } from './utils/frontmatter';
import log from '@main/utils/logger';

const logger = log.scope('main-user-assets');

type UserAdapter = 'claude-code' | 'codex-cli';

// claude-code root（与 SDK settingSources: ['user', ...] 加载一致）
const USER_CLAUDE_ROOT = join(homedir(), '.claude');
const USER_CLAUDE_AGENTS_DIR = join(USER_CLAUDE_ROOT, 'agents');
const USER_CLAUDE_SKILLS_DIR = join(USER_CLAUDE_ROOT, 'skills');

// codex-cli root：官方 custom agents 在 ~/.codex/agents/*.toml，skills 在 ~/.codex/skills/<name>/SKILL.md
const USER_CODEX_ROOT = join(homedir(), '.codex');
const USER_CODEX_AGENTS_DIR = join(USER_CODEX_ROOT, 'agents');
const USER_CODEX_SKILLS_DIR = join(USER_CODEX_ROOT, 'skills');

/**
 * 列出用户自定义 agents/skills；目录不存在视为空清单。每次现扫现读（CRUD 完即时反映）。
 *
 * **plan §D7**：双 adapter root scan，3 次扫描合并：
 * - claude-code agents（~/.claude/agents/）
 * - claude-code skills（~/.claude/skills/）
 * - codex-cli agents（~/.codex/agents/*.toml）
 * - codex-cli skills（~/.codex/skills/）
 *
 * **root-level partial snapshot fallback**（plan §不变量 + reviewer-codex LOW-D）:
 * 每个 scan 函数内部 readdirSync(root) 异常时 console.warn + return [] 不抛错，让 codex root
 * 不可读 / EACCES / 跨 fs 时 claude root assets 仍能展示（不让一个 root 失败拖垮整个 list）。
 */
export function listUserAssets(): UserAssetsSnapshot {
  return {
    agents: [
      ...scanUserAgents('claude-code'),
      ...scanUserAgents('codex-cli'),
    ],
    skills: [
      ...scanUserSkills('claude-code'),
      ...scanUserSkills('codex-cli'),
    ],
  };
}

/**
 * 读单个用户 asset 完整文件文本（含 frontmatter + body），编辑器 mount 用。
 *
 * **plan §D7 升级**：adapter 必传，按 adapter narrow 派发到对应 root。
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
 * **plan §D7 升级**：按 adapter narrow 派发。
 */
export function getUserAssetPath(
  kind: 'agent' | 'skill',
  name: string,
  adapter: UserAdapter,
): string | null {
  if (!isSafeName(name)) return null;
  if (!validateAdapterKind(adapter, kind).ok) return null;
  if (adapter === 'codex-cli' && kind === 'agent') return findCodexUserAgentPathByName(name);
  const path = resolveUserAssetPath(kind, name, adapter);
  return path && existsSync(path) ? path : null;
}

/**
 * 解析 user asset 目标路径（不检查 existsSync，让 caller 决定是返 null 还是 mkdir 写新）。
 *
 * 路径表（plan §D2 §D3）：
 * - claude-code agent → ~/.claude/agents/<name>.md
 * - claude-code skill → ~/.claude/skills/<name>/SKILL.md
 * - codex-cli  agent → ~/.codex/agents/<name>.toml
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
  if (kind === 'agent') return join(USER_CODEX_AGENTS_DIR, `${name}.toml`);
  return join(USER_CODEX_SKILLS_DIR, name, 'SKILL.md');
}

/**
 * 保存用户 asset：拼装 frontmatter + 原子写盘。
 *
 * - claude-code skills → `~/.claude/skills/<name>/SKILL.md`（自动 mkdir 子目录）
 * - claude-code agents → `~/.claude/agents/<name>.md`（mkdir agents 目录）
 * - codex-cli  agents → `~/.codex/agents/<name>.toml`
 * - codex-cli  skills → `~/.codex/skills/<name>/SKILL.md`
 *
 * 校验：
 * - input.adapter + input.kind 通过 validateAdapterKind
 * - name 通过 isSafeName（slug `[a-z0-9-]+`，长度 1-64）
 * - description 必填非空
 * - claude-code agent: model 必填（避免无 model agent 起 SDK 报错）
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
  if (input.kind === 'agent' && input.adapter === 'claude-code') {
    const model = (input.model ?? '').trim();
    if (model.length === 0) return { ok: false, reason: 'agent 必填 model 字段' };
  }

  const targetPath = resolveUserAssetPath(input.kind, input.name, input.adapter);
  if (!targetPath) {
    // 防御性：当前组合都支持；若未来新增 adapter/kind 未接路径，会在这里明确失败。
    return { ok: false, reason: 'unsupported adapter+kind combination (defense in depth)' };
  }

  const body = (input.body ?? '').replace(/\r\n/g, '\n');
  const fileText =
    input.adapter === 'codex-cli' && input.kind === 'agent'
      ? stringifyCodexAgentToml({
          name: input.name,
          description,
          developerInstructions: body,
          model: input.model,
        })
      : buildMarkdownAssetFileText(input, description, body);

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
 * **plan §D7 升级**：adapter 必传，按 adapter narrow 派发。
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
      const path =
        adapter === 'codex-cli'
          ? findCodexUserAgentPathByName(name) ?? join(USER_CODEX_AGENTS_DIR, `${name}.toml`)
          : join(USER_CLAUDE_AGENTS_DIR, `${name}.md`);
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
 * Scan user agents:
 * - claude-code → ~/.claude/agents/<name>.md
 * - codex-cli → ~/.codex/agents/*.toml, using TOML `name` as source of truth
 *
 * **root-level fallback**（reviewer-codex LOW-D）：readdirSync 抛错时 console.warn + return []，
 * 让上层 listUserAssets 仍能 partial snapshot（claude root 不可读时不拖垮 codex root list）。
 */
function scanUserAgents(adapter: UserAdapter): AssetMeta[] {
  if (adapter === 'codex-cli') return scanUserCodexAgents();
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

function scanUserCodexAgents(): AssetMeta[] {
  if (!existsSync(USER_CODEX_AGENTS_DIR)) return [];
  let entries: string[];
  try {
    entries = readdirSync(USER_CODEX_AGENTS_DIR);
  } catch (err) {
    logger.warn(`[user-assets] scanUserAgents readdir failed: ${USER_CODEX_AGENTS_DIR}`, err);
    return [];
  }
  const out: AssetMeta[] = [];
  for (const file of entries) {
    if (!file.endsWith('.toml')) continue;
    const absPath = join(USER_CODEX_AGENTS_DIR, file);
    if (!safeIsFile(absPath)) continue;
    try {
      const parsed = parseCodexAgentToml(readFileSync(absPath, 'utf8'));
      const name = parsed.name;
      if (!name || !isSafeName(name)) continue;
      out.push(__metaBuilders.buildAgentMeta(name, absPath, {
        description: parsed.description ?? '',
        model: parsed.model ?? '',
        model_reasoning_effort: parsed.modelReasoningEffort ?? '',
      }, 'user', 'codex-cli'));
    } catch (err) {
      logger.warn(`[user-assets] skip codex agent ${file}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scan user skills（按 adapter narrow root）：
 * - claude-code → `~/.claude/skills/<name>/SKILL.md`
 * - codex-cli → `~/.codex/skills/<name>/SKILL.md`（skip 历史 `agent-deck/` 子目录是 defense in depth）
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
    // codex root 显式 skip 历史 `agent-deck/` plugin 子目录（defense in depth）。
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

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findCodexUserAgentPathByName(name: string): string | null {
  const direct = join(USER_CODEX_AGENTS_DIR, `${name}.toml`);
  if (existsSync(direct)) return direct;
  if (!existsSync(USER_CODEX_AGENTS_DIR)) return null;
  let entries: string[];
  try {
    entries = readdirSync(USER_CODEX_AGENTS_DIR);
  } catch {
    return null;
  }
  for (const file of entries) {
    if (!file.endsWith('.toml')) continue;
    const absPath = join(USER_CODEX_AGENTS_DIR, file);
    if (!safeIsFile(absPath)) continue;
    try {
      const parsed = parseCodexAgentToml(readFileSync(absPath, 'utf8'));
      if (parsed.name === name) return absPath;
    } catch {
      // scanUserCodexAgents logs parse failures; path lookup remains quiet.
    }
  }
  return null;
}

function buildMarkdownAssetFileText(input: UserAssetInput, description: string, body: string): string {
  const fm: Record<string, string> = { name: input.name, description };
  if (input.kind === 'agent') {
    if (input.tools !== undefined && input.tools.trim().length > 0) fm.tools = input.tools.trim();
    if (input.model !== undefined && input.model.trim().length > 0) fm.model = input.model.trim();
  }
  return `${stringifyFrontmatter(fm)}\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}
