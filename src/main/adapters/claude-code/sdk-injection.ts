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
 *    `systemPrompt: { type: 'preset', preset: 'claude_code', append }` 字段，作为 Claude Code
 *    preset system prompt 的末尾区块。user/project/local CLAUDE.md 由 `settingSources` 另行加载
 *    为 project context，不属于同一个 system prompt 的前后拼接链。
 *
 * 4. Skill / agent 注入位置：通过 SDK 的 `plugins: [{ type: 'local', path }]`。
 *    运行时按 settings 裁剪 app-owned plugin mirror 的 `skills/` / `agents/` 子目录，实现
 *    Claude bundled skills 与 agents 独立开关；用户 / 项目 scope 仍由 Claude Code 原生加载链处理。
 *
 * 5. 加载顺序（CLAUDE.md）：
 *    - 用户副本 `<userData>/agent-deck-claude.md`（设置面板里编辑后写入）→ 优先
 *    - 内置 `resources/claude-config/CLAUDE.md`（应用打包随附）→ 回落
 *    - 都失败 → 空字符串 + warn（让会话照常起来，不阻塞用户）
 *    内存缓存一次，保存/重置时主动 invalidate 让下次新建会话读到新文本；
 *    已运行的 SDK 会话已经把 system prompt 固化进 LLM 上下文，热改无效。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import log from '@main/utils/logger';
import {
  createClaudeMdStore,
  type ClaudeMdStore,
} from './claude-md-store';
import {
  createPluginMirrorStore,
  type PluginMirrorDiagnostic,
  type PluginMirrorFilesystem,
  type PluginMirrorStore,
} from './plugin-mirror-store';
import {
  formatClaudeSystemPromptAppend,
  selectClaudeSessionPlugins,
} from './sdk-injection-core';
import { desktopClaudeSdkInjectionHost } from './sdk-injection-host';

const logger = log.scope('claude-sdk-injection');

let cachedClaudeMdAppend: string | null = null;
let cachedClaudeMdStore:
  | {
      builtinPath: string;
      userPath: string;
      store: ClaudeMdStore;
    }
  | undefined;

function getClaudeMdStore(): ClaudeMdStore {
  const builtinPath = desktopClaudeSdkInjectionHost.builtinClaudeMdPath();
  const userPath = desktopClaudeSdkInjectionHost.userClaudeMdPath();
  if (
    cachedClaudeMdStore?.builtinPath === builtinPath &&
    cachedClaudeMdStore.userPath === userPath
  ) {
    return cachedClaudeMdStore.store;
  }
  const store = createClaudeMdStore({
    builtinPath,
    userPath,
    diagnostics: { warn: (message, error) => logger.warn(message, error) },
  });
  cachedClaudeMdStore = { builtinPath, userPath, store };
  return store;
}

/**
 * 返回 claude 视角 agent-deck plugin source 根的绝对路径。
 *
 * 资产库 / bundled-asset 读取必须用 source path，不能用 SDK 会话的 filtered mirror；否则用户
 * 关闭某类注入后，资产页也会误以为内置资源不存在。
 */
export function getClaudeAgentDeckPluginSourcePath(): string {
  return getPluginSourceDir();
}

/** 返回 plugin source dir（dev=<repo>/resources/.../agent-deck-plugin, prod=<.app>/Contents/Resources/...） */
function getPluginSourceDir(): string {
  return desktopClaudeSdkInjectionHost.pluginSourceDir();
}

/** 返回 plugin mirror dir（<userData>/agent-deck-plugin），含 substitute 后的 .md 文件。 */
function getPluginMirrorDir(): string {
  return desktopClaudeSdkInjectionHost.pluginMirrorDir();
}

interface PluginMirrorOptions {
  includeSkills: boolean;
  includeAgents: boolean;
}

export type { PluginMirrorFilesystem } from './plugin-mirror-store';

const defaultPluginMirrorFilesystem: PluginMirrorFilesystem = {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
};

let pluginMirrorFilesystem = defaultPluginMirrorFilesystem;
let pluginMirrorStore = createMirrorStore(pluginMirrorFilesystem);

/** Test-only reset/injection point; resetting also prevents a prior install signature from masking a test case. */
export function __setPluginMirrorFilesystemForTests(
  overrides: Partial<PluginMirrorFilesystem> = {},
): void {
  pluginMirrorFilesystem = { ...defaultPluginMirrorFilesystem, ...overrides };
  pluginMirrorStore = createMirrorStore(pluginMirrorFilesystem);
}

function createMirrorStore(filesystem: PluginMirrorFilesystem): PluginMirrorStore {
  return createPluginMirrorStore({
    filesystem,
    transformMarkdown: desktopClaudeSdkInjectionHost.substituteMarkdown,
    diagnostic: logPluginMirrorDiagnostic,
  });
}

function logPluginMirrorDiagnostic(event: PluginMirrorDiagnostic): void {
  switch (event.kind) {
    case 'source-missing':
      logger.warn(
        `[sdk-injection] plugin source dir missing, skip mirror install: ${event.source}`,
      );
      return;
    case 'install-failed':
      logger.warn(
        `[sdk-injection] plugin mirror install failed: ${event.destination}`,
        event.error,
      );
      return;
    case 'rollback-failed':
      logger.warn(
        `[sdk-injection] plugin mirror rollback failed: ${event.destination}`,
        event.error,
      );
      return;
    case 'cleanup-failed':
      logger.warn(
        `[sdk-injection] plugin mirror ${event.operation} cleanup failed: ${event.path}`,
        event.error,
      );
  }
}

/**
 * 安装 / 重装 app-owned plugin mirror：先在 destination sibling staging 目录内完整准备，
 * 再以 rename 发布。失败不会污染 live mirror 或 signature cache，调用方拿 null 后跳过插件。
 */
function ensurePluginMirrorInstalled(options: PluginMirrorOptions): string | null {
  return pluginMirrorStore.sync({
    source: getPluginSourceDir(),
    destination: getPluginMirrorDir(),
    ...options,
  });
}

/**
 * 返回要传给 SDK `plugins:` 字段的 plugin 列表。
 *
 * 开关：settings.injectAgentDeckClaudeSkills / injectAgentDeckClaudeAgents 分别控制 mirror
 * 是否保留 `skills/` / `agents/` 子目录。两者都关时返回空数组；只关一侧时仍传同一个 local
 * plugin path，但 mirror 内禁用侧目录已被裁掉。
 *
 * 改这个开关只影响**下次新建**的 SDK 会话；已运行的会话已经在启动时拿到
 * plugin 列表，关掉不会撤销。
 *
 * **claude-code only**：codex SDK 没有 `plugins[]` 字段；Agent Deck 的 Codex baseline 走
 * app-server `developerInstructions`，skills 走 `skills/extraRoots/set`，故本 helper signature
 * 不通用化（plan §P3 Step 3.2 决策）。
 */
export function getAgentDeckPluginsForSession(
  selectedPluginDir?: string,
): Array<{ type: 'local'; path: string }> {
  return selectClaudeSessionPlugins({
    includeSkills: desktopClaudeSdkInjectionHost.readInjectSkills(),
    includeAgents: desktopClaudeSdkInjectionHost.readInjectAgents(),
    installMirror: ensurePluginMirrorInstalled,
    selectedPluginDir,
  });
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
  if (!desktopClaudeSdkInjectionHost.readInjectClaudeMd()) return '';
  if (cachedClaudeMdAppend !== null) {
    return cachedClaudeMdAppend;
  }
  const raw = getClaudeMdStore().getActive().content;
  const substituted = desktopClaudeSdkInjectionHost.substituteMarkdown(raw);
  cachedClaudeMdAppend = formatClaudeSystemPromptAppend(substituted);
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
  return getClaudeMdStore().getActive();
}

/** 永远读内置 CLAUDE.md，给「恢复默认」按钮用。读不到返回空串 + warn。 */
export function getBuiltinAgentDeckClaudeMd(): string {
  return getClaudeMdStore().getBuiltin();
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
  const saved = getClaudeMdStore().saveUser(content);
  invalidateAgentDeckSystemPromptAppend();
  return { content: saved.content, isCustom: true };
}

/** 删除用户副本（如果存在）+ 清缓存，回落到内置。 */
export function resetUserAgentDeckClaudeMd(): void {
  getClaudeMdStore().resetUser();
  invalidateAgentDeckSystemPromptAppend();
}
