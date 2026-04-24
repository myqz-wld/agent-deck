/**
 * Agent Deck 自带的 CLAUDE.md + skill 注入工具。
 *
 * 设计要点：
 * 1. 资源走 package.json 的 build.extraResources（不放 asar 内），与 resources/bin 同模式。
 *    SDK CLI 子进程会扫描 plugin 目录下的 SKILL.md / plugin.json 等文件；
 *    asar 内 fs 行为依赖 Electron 自带 patch，在 spawn 出来的子进程里
 *    不一定可靠（子进程不是 Electron Node），走 extraResources 最稳。
 *
 * 2. 路径分流：
 *    - dev 模式（`pnpm dev`）：<repo>/resources/claude-config/...
 *    - prod (.app)：<app>/Contents/Resources/claude-config/...
 *
 * 3. CLAUDE.md 注入位置：通过 SDK 的
 *    `systemPrompt: { type: 'preset', preset: 'claude_code', append }` 字段，
 *    实际位置在 user/project/local 三层 CLAUDE.md 全部加载完之后追加。
 *    LLM 上下文末尾位置 instruction following 最强。
 *
 * 4. Skill 注入位置：通过 SDK 的 `plugins: [{ type: 'local', path }]`，
 *    skill 自动以 `agent-deck:<skill-name>` 命名空间注册，与用户
 *    `~/.claude/skills/` 不冲突。
 *
 * 5. 加载顺序（CLAUDE.md）：
 *    - 用户副本 `<userData>/agent-deck-claude.md`（设置面板里编辑后写入）→ 优先
 *    - 内置 `resources/claude-config/CLAUDE.md`（应用打包随附）→ 回落
 *    - 都失败 → 空字符串 + warn（让会话照常起来，不阻塞用户）
 *    内存缓存一次，保存/重置时主动 invalidate 让下次新建会话读到新文本；
 *    已运行的 SDK 会话已经把 system prompt 固化进 LLM 上下文，热改无效。
 */
import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { settingsStore } from '@main/store/settings-store';

const USER_CLAUDE_MD_FILENAME = 'agent-deck-claude.md';
const APPEND_HEADER =
  '\n\n--- Agent Deck 应用约定（随应用打包，独立于 user/project/local CLAUDE.md）---\n\n';

let cachedClaudeMdAppend: string | null = null;

/**
 * 返回 agent-deck 自带 plugin 根的绝对路径，传给 SDK 的 `plugins[].path`。
 * SDK 会读 `<plugin>/.claude-plugin/plugin.json` + 扫 `<plugin>/skills/`。
 */
export function getAgentDeckPluginPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'claude-config', 'agent-deck-plugin');
  }
  return join(app.getAppPath(), 'resources', 'claude-config', 'agent-deck-plugin');
}

/** 内置 CLAUDE.md 在 .app / repo 内的绝对路径（dev/prod 自动分流）。 */
function getBuiltinClaudeMdPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'claude-config', 'CLAUDE.md');
  }
  return join(app.getAppPath(), 'resources', 'claude-config', 'CLAUDE.md');
}

/** 用户副本 CLAUDE.md 的绝对路径（与 settings.json 同 userData 目录，独立文件）。 */
function getUserClaudeMdPath(): string {
  return join(app.getPath('userData'), USER_CLAUDE_MD_FILENAME);
}

/**
 * 读取 agent-deck 自带 CLAUDE.md，返回追加到 SDK preset system prompt 末尾的文本。
 *
 * 加载优先级：用户副本 → 内置 → 空字符串。
 * 失败兜底：返回空字符串 + console.warn，让会话照常起来（不阻塞用户操作）。
 * SDK 接受 append 为空字符串等价于不追加。
 *
 * 开关：settings.injectAgentDeckClaudeMd === false 时直接返回空串
 * （settings panel 里有 toggle 让用户彻底禁用注入）。这条优先于缓存读取，
 * 让用户关掉之后立刻生效（搭配 SettingsSet handler 内的 invalidate 调用）。
 */
export function getAgentDeckSystemPromptAppend(): string {
  if (!settingsStore.get('injectAgentDeckClaudeMd')) return '';
  if (cachedClaudeMdAppend !== null) {
    return cachedClaudeMdAppend;
  }
  const raw = readActiveClaudeMdRaw();
  cachedClaudeMdAppend = raw ? `${APPEND_HEADER}${raw}` : '';
  return cachedClaudeMdAppend;
}

/** 清除内存缓存：保存 / 重置用户副本后调用，让下一次新建会话读到新文本。 */
export function invalidateAgentDeckSystemPromptAppend(): void {
  cachedClaudeMdAppend = null;
}

/**
 * 读取「当前生效」的 CLAUDE.md 原文（不含 APPEND_HEADER），给设置面板用。
 * isCustom = true 表示当前是用户副本，false 表示回落到内置。
 */
export function getActiveAgentDeckClaudeMd(): { content: string; isCustom: boolean } {
  const userPath = getUserClaudeMdPath();
  if (existsSync(userPath)) {
    try {
      return { content: readFileSync(userPath, 'utf8'), isCustom: true };
    } catch (err) {
      console.warn('[sdk-injection] 读取用户副本 CLAUDE.md 失败，回落内置:', err);
    }
  }
  return { content: getBuiltinAgentDeckClaudeMd(), isCustom: false };
}

/** 永远读内置 CLAUDE.md，给「恢复默认」按钮用。读不到返回空串 + warn。 */
export function getBuiltinAgentDeckClaudeMd(): string {
  try {
    return readFileSync(getBuiltinClaudeMdPath(), 'utf8');
  } catch (err) {
    console.warn('[sdk-injection] 读取内置 CLAUDE.md 失败:', err);
    return '';
  }
}

/**
 * 写用户副本到 userData/agent-deck-claude.md 并清缓存。
 * 调用方负责把内容传过来；不做 schema 校验（用户全责）。
 *
 * 原子写：write tmp + rename，与 hook-installer.writeSettings 同模式。
 * REVIEW_2 修：原本直接 writeFileSync 覆盖，进程崩溃 / 磁盘满会留半截文件，
 *           下次 readFileSync 会拿到截断内容当生效注入。
 */
export function saveUserAgentDeckClaudeMd(content: string): void {
  const path = getUserClaudeMdPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  invalidateAgentDeckSystemPromptAppend();
}

/** 删除用户副本（如果存在）+ 清缓存，回落到内置。 */
export function resetUserAgentDeckClaudeMd(): void {
  const path = getUserClaudeMdPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch (err) {
      console.warn('[sdk-injection] 删除用户副本 CLAUDE.md 失败:', err);
      throw err;
    }
  }
  invalidateAgentDeckSystemPromptAppend();
}

/** 内部：按优先级读出当前生效内容（不带 header）。 */
function readActiveClaudeMdRaw(): string {
  const userPath = getUserClaudeMdPath();
  if (existsSync(userPath)) {
    try {
      return readFileSync(userPath, 'utf8');
    } catch (err) {
      console.warn('[sdk-injection] 读取用户副本 CLAUDE.md 失败，回落内置:', err);
    }
  }
  try {
    return readFileSync(getBuiltinClaudeMdPath(), 'utf8');
  } catch (err) {
    console.warn('[sdk-injection] 读取 agent-deck CLAUDE.md 失败，跳过注入:', err);
    return '';
  }
}
