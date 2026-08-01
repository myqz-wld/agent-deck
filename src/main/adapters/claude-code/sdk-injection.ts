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
import { app } from 'electron';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';
import log from '@main/utils/logger';

const logger = log.scope('claude-sdk-injection');

const USER_CLAUDE_MD_FILENAME = 'agent-deck-claude.md';
const APPEND_HEADER =
  '\n\n--- Agent Deck 应用约定（随应用打包，独立于 user/project/local CLAUDE.md）---\n\n';

let cachedClaudeMdAppend: string | null = null;

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
  if (app.isPackaged) {
    return join(process.resourcesPath, 'claude-config', 'agent-deck-plugin');
  }
  return join(app.getAppPath(), 'resources', 'claude-config', 'agent-deck-plugin');
}

/** 返回 plugin mirror dir（<userData>/agent-deck-plugin），含 substitute 后的 .md 文件。 */
function getPluginMirrorDir(): string {
  return join(app.getPath('userData'), 'agent-deck-plugin');
}

let pluginMirrorSignature: string | null = null;

interface PluginMirrorOptions {
  includeSkills: boolean;
  includeAgents: boolean;
}

interface PluginMirrorPublicationState {
  stagingPath: string;
  backupPath: string | null;
  stagingPublished: boolean;
  /** True only while the backup is the last known location of the old live mirror. */
  backupContainsLiveMirror: boolean;
}

/** Narrow synchronous filesystem seam so install failure cases stay deterministic in tests. */
export interface PluginMirrorFilesystem {
  cpSync: typeof cpSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  mkdtempSync: typeof mkdtempSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
}

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

/** Test-only reset/injection point; resetting also prevents a prior install signature from masking a test case. */
export function __setPluginMirrorFilesystemForTests(
  overrides: Partial<PluginMirrorFilesystem> = {},
): void {
  pluginMirrorFilesystem = { ...defaultPluginMirrorFilesystem, ...overrides };
  pluginMirrorSignature = null;
}

/**
 * 安装 / 重装 app-owned plugin mirror：先在 destination sibling staging 目录内完整准备，
 * 再以 rename 发布。失败不会污染 live mirror 或 signature cache，调用方拿 null 后跳过插件。
 */
function ensurePluginMirrorInstalled(options: PluginMirrorOptions): string | null {
  const src = getPluginSourceDir();
  const dst = getPluginMirrorDir();
  const signature = `${src}|skills:${options.includeSkills ? 'on' : 'off'}|agents:${options.includeAgents ? 'on' : 'off'}`;
  if (pluginMirrorSignature === signature && isPluginMirrorValid(dst, options)) {
    return dst;
  }

  // A stale/missing cached live mirror must be reinstalled, never injected as though it were usable.
  pluginMirrorSignature = null;
  if (!pluginMirrorFilesystem.existsSync(src)) {
    logger.warn(`[sdk-injection] plugin source dir missing, skip mirror install: ${src}`);
    return null;
  }

  let publication: PluginMirrorPublicationState | null = null;
  try {
    const stagingPath = createPluginMirrorOperationDirectory(dst, 'staging');
    publication = {
      stagingPath,
      backupPath: null,
      stagingPublished: false,
      backupContainsLiveMirror: false,
    };
    preparePluginMirrorInStaging(src, stagingPath, options);
    publishPreparedPluginMirror(dst, publication);
    pluginMirrorSignature = signature;
    return dst;
  } catch (err) {
    logger.warn(`[sdk-injection] plugin mirror install failed: ${dst}`, err);
    pluginMirrorSignature = null;
    return null;
  } finally {
    if (publication && !publication.stagingPublished) {
      cleanupPluginMirrorOperationPath(publication.stagingPath, 'staging');
    }
    // Preserve the backup when rollback itself failed: it is still the only valid old mirror.
    if (publication?.backupPath && !publication.backupContainsLiveMirror) {
      cleanupPluginMirrorOperationPath(publication.backupPath, 'backup');
    }
  }
}

/** Creates a unique sibling directory, guaranteeing the staged data shares destination's filesystem. */
function createPluginMirrorOperationDirectory(destination: string, kind: 'staging' | 'backup'): string {
  const parent = dirname(destination);
  pluginMirrorFilesystem.mkdirSync(parent, { recursive: true });
  return pluginMirrorFilesystem.mkdtempSync(
    join(parent, `.${basename(destination)}.${kind}-${process.pid}-`),
  );
}

/** Completes all mutations and validation before the live destination is renamed. */
function preparePluginMirrorInStaging(
  source: string,
  stagingPath: string,
  options: PluginMirrorOptions,
): void {
  pluginMirrorFilesystem.cpSync(source, stagingPath, { recursive: true });
  if (!options.includeSkills) {
    pluginMirrorFilesystem.rmSync(join(stagingPath, 'skills'), { recursive: true, force: true });
  }
  if (!options.includeAgents) {
    pluginMirrorFilesystem.rmSync(join(stagingPath, 'agents'), { recursive: true, force: true });
  }
  substituteMdFilesInPlace(stagingPath);
  assertPluginMirrorValid(stagingPath, options);
}

/** Publishes the ready tree. Non-empty-directory platforms use a bounded backup + rollback sequence. */
function publishPreparedPluginMirror(destination: string, state: PluginMirrorPublicationState): void {
  if (pluginMirrorFilesystem.existsSync(destination)) {
    const backupPath = createPluginMirrorOperationDirectory(destination, 'backup');
    state.backupPath = backupPath;
    // rename requires a non-existing target on platforms that reject replacing a non-empty directory.
    pluginMirrorFilesystem.rmSync(backupPath, { recursive: true, force: true });
    pluginMirrorFilesystem.renameSync(destination, backupPath);
    state.backupContainsLiveMirror = true;
  }

  try {
    pluginMirrorFilesystem.renameSync(state.stagingPath, destination);
    state.stagingPublished = true;
    state.backupContainsLiveMirror = false;
  } catch (publishError) {
    if (state.backupPath && state.backupContainsLiveMirror) {
      try {
        pluginMirrorFilesystem.renameSync(state.backupPath, destination);
        state.backupContainsLiveMirror = false;
      } catch (rollbackError) {
        logger.warn(`[sdk-injection] plugin mirror rollback failed: ${destination}`, rollbackError);
      }
    }
    throw publishError;
  }
}

/** Validates the minimal plugin contract and expected prune state without mutating the mirror. */
function assertPluginMirrorValid(dir: string, options: PluginMirrorOptions): void {
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  if (!pluginMirrorFilesystem.existsSync(manifestPath)) {
    throw new Error(`plugin manifest missing: ${manifestPath}`);
  }
  JSON.parse(pluginMirrorFilesystem.readFileSync(manifestPath, 'utf8'));
  if (!options.includeSkills && pluginMirrorFilesystem.existsSync(join(dir, 'skills'))) {
    throw new Error(`disabled skills directory remains in mirror: ${dir}`);
  }
  if (!options.includeAgents && pluginMirrorFilesystem.existsSync(join(dir, 'agents'))) {
    throw new Error(`disabled agents directory remains in mirror: ${dir}`);
  }
}

function isPluginMirrorValid(dir: string, options: PluginMirrorOptions): boolean {
  try {
    assertPluginMirrorValid(dir, options);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort cleanup is intentionally one-shot and scoped to this operation's unique sibling path. */
function cleanupPluginMirrorOperationPath(path: string, kind: 'staging' | 'backup'): void {
  try {
    if (pluginMirrorFilesystem.existsSync(path)) {
      pluginMirrorFilesystem.rmSync(path, { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn(`[sdk-injection] plugin mirror ${kind} cleanup failed: ${path}`, err);
  }
}

/** Walk 目录递归找 .md 文件，对每个做 placeholder substitute（如有占位符）。 */
function substituteMdFilesInPlace(dir: string): void {
  for (const entry of pluginMirrorFilesystem.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteMdFilesInPlace(path);
      continue;
    }
    if (!entry.isFile() || !path.endsWith('.md')) continue;
    const raw = pluginMirrorFilesystem.readFileSync(path, 'utf8');
    const substituted = substituteResourcesPlaceholder(raw);
    if (substituted !== raw) {
      pluginMirrorFilesystem.writeFileSync(path, substituted, 'utf8');
    }
  }
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
  const includeSkills = settingsStore.get('injectAgentDeckClaudeSkills') !== false;
  const includeAgents = settingsStore.get('injectAgentDeckClaudeAgents') !== false;
  const plugins: Array<{ type: 'local'; path: string }> = [];
  if (includeSkills || includeAgents) {
    const mirrorPath = ensurePluginMirrorInstalled({ includeSkills, includeAgents });
    if (mirrorPath) {
      plugins.push({ type: 'local', path: mirrorPath });
    }
  }
  if (selectedPluginDir && !plugins.some((plugin) => plugin.path === selectedPluginDir)) {
    plugins.push({ type: 'local', path: selectedPluginDir });
  }
  return plugins;
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
  const substituted = substituteResourcesPlaceholder(raw);
  cachedClaudeMdAppend = substituted ? `${APPEND_HEADER}${substituted}` : '';
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
      logger.warn('[sdk-injection] 读取用户副本 CLAUDE.md 失败，回落内置:', err);
    }
  }
  return { content: getBuiltinAgentDeckClaudeMd(), isCustom: false };
}

/** 永远读内置 CLAUDE.md，给「恢复默认」按钮用。读不到返回空串 + warn。 */
export function getBuiltinAgentDeckClaudeMd(): string {
  try {
    return readFileSync(getBuiltinClaudeMdPath(), 'utf8');
  } catch (err) {
    logger.warn('[sdk-injection] 读取内置 CLAUDE.md 失败:', err);
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
      logger.warn('[sdk-injection] 删除用户副本 CLAUDE.md 失败:', err);
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
      logger.warn('[sdk-injection] 读取用户副本 CLAUDE.md 失败，回落内置:', err);
    }
  }
  try {
    return readFileSync(getBuiltinClaudeMdPath(), 'utf8');
  } catch (err) {
    logger.warn('[sdk-injection] 读取 agent-deck CLAUDE.md 失败，跳过注入:', err);
    return '';
  }
}
