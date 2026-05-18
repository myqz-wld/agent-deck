/**
 * 用户自定义 agents/skills 管理（CHANGELOG_57 C2）。
 *
 * 数据源：用户主目录下 Claude Code SDK 默认加载的两个目录
 *   - `~/.claude/agents/<name>.md`        —— frontmatter: name/description/tools/model + body
 *   - `~/.claude/skills/<name>/SKILL.md`  —— frontmatter: name/description + body
 *
 * 这两条路径与 SDK 的 `settingSources: ['user', 'project', 'local']` 加载约定一致；
 * 应用只是提供可视化编辑器（list/save/delete/reveal），不做注入逻辑——文件落盘后
 * 下次新建 SDK 会话自动可见，与运行中的会话无关。
 *
 * 写盘走原子写（write tmp + rename），与 sdk-injection.ts 的 saveUserAgentDeckClaudeMd 同模式
 * （REVIEW_2 教训：直接覆盖写在崩溃 / 磁盘满时会留半截文件，被 SDK 当生效注入）。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AssetMeta, UserAssetInput, UserAssetsSnapshot } from '@shared/types';
import { __metaBuilders, isSafeName } from './bundled-assets';
import { parseFrontmatter, stringifyFrontmatter } from './utils/frontmatter';

const USER_CLAUDE_ROOT = join(homedir(), '.claude');
const USER_AGENTS_DIR = join(USER_CLAUDE_ROOT, 'agents');
const USER_SKILLS_DIR = join(USER_CLAUDE_ROOT, 'skills');

/** 列出用户自定义 agents/skills；目录不存在视为空清单。每次现扫现读（CRUD 完即时反映）。 */
export function listUserAssets(): UserAssetsSnapshot {
  return {
    agents: scanUserAgents(),
    skills: scanUserSkills(),
  };
}

/** 读单个用户 asset 完整文件文本（含 frontmatter + body），编辑器 mount 用。 */
export function getUserAssetContent(
  kind: 'agent' | 'skill',
  name: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (!isSafeName(name)) return { ok: false, reason: `name 非法（需匹配 ASSET_NAME_REGEX）：${name}` };
  const path = getUserAssetPath(kind, name);
  if (!path) return { ok: false, reason: `not found: ${kind}/${name}` };
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 返回用户 asset 的绝对路径，给 shell.showItemInFolder 用。不存在返回 null。 */
export function getUserAssetPath(kind: 'agent' | 'skill', name: string): string | null {
  if (!isSafeName(name)) return null;
  const path = kind === 'agent' ? join(USER_AGENTS_DIR, `${name}.md`) : join(USER_SKILLS_DIR, name, 'SKILL.md');
  return existsSync(path) ? path : null;
}

/**
 * 保存用户 asset：拼装 frontmatter + 原子写盘。
 *
 * - skills → `~/.claude/skills/<name>/SKILL.md`（自动 mkdir 子目录）
 * - agents → `~/.claude/agents/<name>.md`（mkdir agents 目录）
 *
 * 校验：
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

  const targetPath = input.kind === 'agent'
    ? join(USER_AGENTS_DIR, `${input.name}.md`)
    : join(USER_SKILLS_DIR, input.name, 'SKILL.md');

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
 * **拒删 symlink / junction**（CHANGELOG_57 R1·Q1 兜底）：lstatSync 检查目标本身（不 follow），
 * 若是 symlink / Win NTFS junction 直接拒绝，要求用户在文件管理器手动处理。
 * 用户自己往自己 home 放 symlink 不属跨边界攻击，但 rmSync recursive force 在 Win 上对 junction
 * 的行为未验证；保守拒删可避免跨平台变种破坏（user 看到错误信息能去 Finder/资源管理器人工删）。
 */
export function deleteUserAsset(
  kind: 'agent' | 'skill',
  name: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isSafeName(name)) return { ok: false, reason: `name 非法（需匹配 ASSET_NAME_REGEX）：${name}` };
  try {
    if (kind === 'agent') {
      const path = join(USER_AGENTS_DIR, `${name}.md`);
      if (!existsSync(path)) return { ok: true };
      const lst = lstatSync(path);
      if (lst.isSymbolicLink()) {
        return { ok: false, reason: 'agent 是 symlink，请在文件管理器手动删除' };
      }
      unlinkSync(path);
    } else {
      const dir = join(USER_SKILLS_DIR, name);
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

function scanUserAgents(): AssetMeta[] {
  if (!existsSync(USER_AGENTS_DIR)) return [];
  const out: AssetMeta[] = [];
  for (const file of readdirSync(USER_AGENTS_DIR)) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (!isSafeName(name)) continue;
    const absPath = join(USER_AGENTS_DIR, file);
    try {
      const fm = parseFrontmatter(readFileSync(absPath, 'utf8'));
      out.push(__metaBuilders.buildAgentMeta(name, absPath, fm, 'user', null));
    } catch (err) {
      console.warn(`[user-assets] skip agent ${name}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function scanUserSkills(): AssetMeta[] {
  if (!existsSync(USER_SKILLS_DIR)) return [];
  const out: AssetMeta[] = [];
  for (const entry of readdirSync(USER_SKILLS_DIR)) {
    if (!isSafeName(entry)) continue;
    const skillDir = join(USER_SKILLS_DIR, entry);
    if (!safeIsDir(skillDir)) continue;
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'));
      out.push(__metaBuilders.buildSkillMeta(entry, skillFile, fm, 'user', null));
    } catch (err) {
      console.warn(`[user-assets] skip skill ${entry}:`, (err as Error).message);
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
