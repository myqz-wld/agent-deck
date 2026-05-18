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
 * 返回 claude 视角 agent-deck plugin 根的绝对路径，传给 SDK 的 `plugins[].path`。
 * SDK 会读 `<plugin>/.claude-plugin/plugin.json` + 自动扫 `<plugin>/skills/` 与
 * `<plugin>/agents/` 子目录（skills 与 agents 一同注入，绑定生效）。
 *
 * codex 视角同款路径在 `src/main/adapters/codex-cli/codex-config-paths.ts:getCodexAgentDeckPluginPath`，
 * 双 root scan 各自直接 import 在 `src/main/bundled-assets.ts`（P5 Round 1 reviewer-claude MED
 * 修法删除原 agent-deck-plugin-paths.ts 死代码 dispatcher — 0 production caller，违反 §提示词
 * 资产维护 约束 2）。
 */
export function getClaudeAgentDeckPluginPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'claude-config', 'agent-deck-plugin');
  }
  return join(app.getAppPath(), 'resources', 'claude-config', 'agent-deck-plugin');
}

/**
 * 返回要传给 SDK `plugins:` 字段的 plugin 列表。
 *
 * 开关：settings.injectAgentDeckPlugin === false 时返回空数组（设置面板里有
 * toggle 让用户彻底禁用 plugin 注入，与 CLAUDE.md 注入开关同模式）。**plugin 整体
 * 注入或整体不注入**——skills（含 deep-code-review）与 agents（含 reviewer-claude /
 * reviewer-codex）共享这一个 toggle，由 SDK 自动按子目录扫描加载。
 *
 * 改这个开关只影响**下次新建**的 SDK 会话；已运行的会话已经在启动时拿到
 * plugin 列表，关掉不会撤销。
 *
 * **claude-code only**：codex SDK 没有 `plugins[]` 字段（走 `~/.codex/AGENTS.md` 静态
 * 注入 + `~/.codex/agents/` 目录），故本 helper signature 不通用化（plan §P3 Step 3.2 决策）。
 */
export function getAgentDeckPluginsForSession(): Array<{ type: 'local'; path: string }> {
  if (!settingsStore.get('injectAgentDeckPlugin')) return [];
  return [{ type: 'local', path: getClaudeAgentDeckPluginPath() }];
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
 * 返回**实际写盘后读回**的内容（REVIEW_4 M11）：让 renderer 用真实写盘内容更新本地 loaded
 * 状态，而非用 draft 直接 set —— 如果 main 端将来做规范化（去 BOM/CRLF→LF/补尾换行），
 * 用 draft 直接 set 会让下次 dirty 永真，「保存」按钮永亮但 IPC 没东西可写。
 *
 * 原子写：write tmp + rename，与 hook-installer.writeSettings 同模式。
 * REVIEW_2 修：原本直接 writeFileSync 覆盖，进程崩溃 / 磁盘满会留半截文件，
 *           下次 readFileSync 会拿到截断内容当生效注入。
 */
export function saveUserAgentDeckClaudeMd(content: string): { content: string; isCustom: true } {
  const path = getUserClaudeMdPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  invalidateAgentDeckSystemPromptAppend();
  return { content: readFileSync(path, 'utf8'), isCustom: true };
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
