/**
 * Codex `~/.codex/AGENTS.md` Agent Deck 注入段管理（CHANGELOG_<X> D1，含 D5 决策实现）。
 *
 * 设计目标：让 Agent Deck 把自带的应用约定同步到 codex 一侧的 AGENTS.md，让 codex
 * 会话也能享受 Agent Deck 的项目通用约定（输出语言 / 运行时 / 决策对抗 / 等）。
 *
 * **plan codex-handoff-team-alignment-20260518 §D5 fallback 策略（P3 Step 3.6 修法）**:
 * 内置内容源切到 `resources/codex-config/CODEX_AGENTS.md`（codex 视角约定独立维护，不再
 * 共享 claude-config/CLAUDE.md 同一份）。
 * - codex-config/CODEX_AGENTS.md 不存在 → throw 显式 error（**禁** silent fallback 到
 *   claude-config/CLAUDE.md，避免 typecheck/build 过但运行时 codex AGENTS.md 注入静默
 *   退化到 claude 视角内容，让用户视角直到跑 codex 才发现错）
 *
 * **D5 决策（用户拍板）**：单向 overwrite Agent Deck 段，用户段（marker 之外的内容）
 * 严格保留。用户在 Agent Deck 段内手改不会反向同步到 <userData>/agent-deck-codex-agents.md
 * 副本——下次启动应用同步会被重新覆盖（marker 段是 Agent Deck 自管区域）。
 *
 * 实现策略：marker 包裹 + 整段替换（与 toml-writer 同模式）：
 *
 *   <!-- === Agent Deck START - DO NOT EDIT THIS BLOCK === -->
 *   _Agent Deck 自动写入；编辑请在 Agent Deck 设置面板「应用约定」中改_
 *   _手动改不会生效，下次启动同步会被覆盖_
 *
 *   ## Agent Deck 应用约定
 *
 *   ... CODEX_AGENTS.md 内容 ...
 *
 *   <!-- === Agent Deck END === -->
 *
 * - HTML 注释 marker：codex parse AGENTS.md 当 markdown，HTML 注释**不影响渲染**也不
 *   影响 prompt（codex CLI 把整个 AGENTS.md 拼到 system prompt，注释行作为字符出现在
 *   LLM 上下文里但不会触发任何特殊行为）
 * - 用户手写的其他段（marker 之外）严格保留
 * - 自愈：marker 缺失 / 损坏 / 用户删了 → 下次启动追加新段
 *
 * 加载优先级（与 sdk-injection.ts 同模式）：
 * - 用户副本 `<userData>/agent-deck-codex-agents.md` → 优先（用户自定义 codex 视角约定）
 * - 内置 `resources/codex-config/CODEX_AGENTS.md` → 回落（codex 视角默认约定）
 * - 都失败 → throw（D5 fallback 策略，让 caller syncAgentDeckSection 决定是否阻断启动）
 *
 * 同步时机：
 * - app ready 后：调 `syncAgentDeckSection()`（首次启动 / 升级后）
 * - settings 改了 `injectAgentDeckCodexAgentsMd` toggle：开 → 同步；关 → 移除段（用户主动控制）
 * - 用户在「应用约定」编辑器保存后：清缓存 + 同步
 *
 * 不实现：
 * - 双向同步（用户改 Agent Deck 段反向回 <userData>）—— D5 决策不做
 * - 外部 watch / hot reload monitor 监听 ~/.codex/AGENTS.md 外部改动（用户手改 marker 外保留即可）
 * - 跨进程通知 codex 在跑会话重新加载约定（codex SDK 不支持热重载 AGENTS.md，
 *   下次新建会话生效，与 sdk-injection.ts 同模式）
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';
import log from '@main/utils/logger';

const logger = log.scope('codex-agents-md');

const MARKER_START = '<!-- === Agent Deck START - DO NOT EDIT THIS BLOCK === -->';
const MARKER_END = '<!-- === Agent Deck END === -->';
const SECTION_BANNER =
  '_Agent Deck 自动写入；编辑请在 Agent Deck 设置面板「应用约定」中改_  \n' +
  '_手动改不会生效，下次启动同步会被覆盖_';
const SECTION_HEADER = '## Agent Deck 应用约定';

const USER_AGENTS_MD_FILENAME = 'agent-deck-codex-agents.md';

/** ~/.codex/AGENTS.md 绝对路径（不依赖 app.getPath，便于单测）。 */
export function getCodexAgentsMdPath(): string {
  return join(homedir(), '.codex', 'AGENTS.md');
}

/** 用户副本 codex AGENTS.md 内容的绝对路径（与 settings.json 同 userData 目录）。 */
function getUserCodexAgentsMdPath(): string {
  return join(app.getPath('userData'), USER_AGENTS_MD_FILENAME);
}

/**
 * 内置 codex AGENTS.md 内容的绝对路径（plan §D5 fallback 策略 P3 Step 3.6 修法 — 切到
 * codex 视角独立维护的 codex-config/CODEX_AGENTS.md，不再共享 claude-config/CLAUDE.md）。
 */
function getBuiltinAgentsMdContentPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'codex-config', 'CODEX_AGENTS.md');
  }
  return join(app.getAppPath(), 'resources', 'codex-config', 'CODEX_AGENTS.md');
}

/**
 * 内置 markdown 内容（plan §D5 fallback 策略 P3 Step 3.6 修法）。
 * 加载优先级：用户副本 → 内置 codex-config/CODEX_AGENTS.md → throw。
 *
 * 内存缓存：与 sdk-injection.ts 各自维护一份缓存（两条注入通路独立 invalidate）。
 * 改 CODEX_AGENTS.md 编辑器保存后调 invalidateCodexAgentsMdContent() 让下次同步读最新。
 */
let cachedContent: string | null = null;

export function invalidateCodexAgentsMdContent(): void {
  cachedContent = null;
}

function readContentRaw(): string {
  const userPath = getUserCodexAgentsMdPath();
  if (existsSync(userPath)) {
    try {
      return readFileSync(userPath, 'utf8');
    } catch (err) {
      logger.warn('[codex-agents-md] 读用户副本失败，回落内置:', err);
    }
  }
  try {
    return readFileSync(getBuiltinAgentsMdContentPath(), 'utf8');
  } catch (err) {
    // plan §D5 fallback 策略: codex-config/CODEX_AGENTS.md 不存在即 throw,禁 silent
    // fallback 到 claude-config/CLAUDE.md(避免 typecheck/build 过但运行时 codex AGENTS.md
    // 注入静默退化到 claude 视角内容,让用户视角直到跑 codex 才发现错)。
    // syncAgentDeckSection 内 try/catch 兜底转 error log(不阻断启动,但 prominent log 让
    // dev / prod 用户立即看到错)。
    throw new Error(
      `codex-config/CODEX_AGENTS.md missing or unreadable, build/dev config error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getContent(): string {
  if (cachedContent !== null) return cachedContent;
  cachedContent = readContentRaw();
  return cachedContent;
}

/**
 * 同步 Agent Deck 段到 ~/.codex/AGENTS.md。
 *
 * 行为：
 * - settings.injectAgentDeckCodexAgentsMd === false → 移除 Agent Deck 段（保留用户内容）
 * - true（默认）→ 写入 / 替换 Agent Deck 段
 * - 内容空 / 读失败 → 跳过（不破坏现有 AGENTS.md）
 *
 * **plan §D5 fallback 策略（P3 Step 3.6 修法）**：getContent() 内部 throw 时本函数 catch
 * + 转 console.error prominent log（不阻断启动 — caller main bootstrap 仍能继续；但 log
 * 显著高于 warn，让 dev / prod 用户立即看到 codex-config/CODEX_AGENTS.md 缺失错）。
 *
 * 不抛错：DB / 配置异常都 warn 不阻断启动。
 *
 * @returns 写入后的完整文件内容（用于测试 / 调试）；跳过时返回 null
 */
export function syncAgentDeckSection(
  configPath: string = getCodexAgentsMdPath(),
): string | null {
  const enabled = settingsStore.get('injectAgentDeckCodexAgentsMd');
  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch (err) {
      logger.warn(`[codex-agents-md] 读 ${configPath} 失败:`, err);
      return null;
    }
  }

  if (!enabled) {
    // 移除 Agent Deck 段，保留用户内容；如果原本就没我们的段，noop
    const next = removeMarkerSection(existing);
    if (next === existing) return existing;
    atomicWrite(configPath, next);
    return next;
  }

  // plan §D5 fallback 策略 (P3 Step 3.6): getContent() 内部读 CODEX_AGENTS.md 失败时 throw,
  // 此处 catch 转 console.error prominent log + return null 跳过同步(不阻断启动)。
  let content: string;
  try {
    content = getContent();
  } catch (err) {
    logger.error(
      `[codex-agents-md] D5 fallback 策略触发: codex-config/CODEX_AGENTS.md 内置内容读取失败,跳过同步。` +
        ` 这通常意味着 build/dev config 错误(extraResources 漏配 codex-config / 文件被误删)。` +
        ` 详见 plan codex-handoff-team-alignment-20260518 §D5。详细错误:`,
      err,
    );
    return null;
  }
  if (!content.trim()) return null;
  // CHANGELOG_169 / REVIEW_<X>: substitute {{AGENT_DECK_RESOURCES}} placeholder with absolute
  // path right before writing to ~/.codex/AGENTS.md so the codex agent in user-project cwd can
  // directly `bash` / `cat` SOPs/templates. Mirrors sdk-injection.ts (claude end) substitution
  // in getAgentDeckSystemPromptAppend.
  const substituted = substituteResourcesPlaceholder(content);
  const newSection = buildSection(substituted);
  const next = replaceOrAppendMarkerSection(existing, newSection);
  if (next === existing) return existing;
  atomicWrite(configPath, next);
  return next;
}

/**
 * 拿当前 Agent Deck 段（marker 之间）的内容，给设置面板预览用。
 * 段不存在 / 文件不存在返回 null。
 */
export function readAgentDeckSection(
  configPath: string = getCodexAgentsMdPath(),
): string | null {
  if (!existsSync(configPath)) return null;
  let content = '';
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  const sectionRe = new RegExp(
    `${escapeRegex(MARKER_START)}([\\s\\S]*?)${escapeRegex(MARKER_END)}`,
    'm',
  );
  const m = sectionRe.exec(content);
  return m ? m[1].trim() : null;
}

/**
 * 读取「当前生效」的 codex CODEX_AGENTS.md 原文(不含 marker / banner / header,只是 raw markdown
 * 内容主体),给设置面板用。isCustom = true 表示当前是用户副本,false 表示回落到内置。
 *
 * 与 sdk-injection.ts:getActiveAgentDeckClaudeMd 对偶 — claude 副本在 `<userData>/agent-deck-claude.md`,
 * codex 副本在 `<userData>/agent-deck-codex-agents.md`,两份独立文件互不影响。
 */
export function getActiveCodexAgentsMd(): { content: string; isCustom: boolean } {
  const userPath = getUserCodexAgentsMdPath();
  if (existsSync(userPath)) {
    try {
      return { content: readFileSync(userPath, 'utf8'), isCustom: true };
    } catch (err) {
      logger.warn('[codex-agents-md] 读取用户副本失败,回落内置:', err);
    }
  }
  return { content: getBuiltinCodexAgentsMd(), isCustom: false };
}

/** 永远读内置 codex-config/CODEX_AGENTS.md,给「恢复默认」按钮用。读不到返回空串 + warn。 */
export function getBuiltinCodexAgentsMd(): string {
  try {
    return readFileSync(getBuiltinAgentsMdContentPath(), 'utf8');
  } catch (err) {
    logger.warn('[codex-agents-md] 读取内置 CODEX_AGENTS.md 失败:', err);
    return '';
  }
}

/**
 * 写用户副本到 userData/agent-deck-codex-agents.md + invalidate cache + 立即同步 ~/.codex/AGENTS.md
 * 段(让 codex CLI 下次新建 thread 加载到新内容)。返回写盘后实际读回的内容(对偶
 * sdk-injection.ts:saveUserAgentDeckClaudeMd REVIEW_4 M11 修法,防 main 端规范化让 dirty 永真)。
 *
 * 原子写: write tmp + rename(对偶 sdk-injection saveUserAgentDeckClaudeMd / hook-installer.writeSettings)。
 */
export function saveUserCodexAgentsMd(content: string): { content: string; isCustom: true } {
  const path = getUserCodexAgentsMdPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  invalidateCodexAgentsMdContent();
  // 立即同步 ~/.codex/AGENTS.md Agent Deck 段(否则用户副本改了但 codex SDK 仍读旧 cache /
  // 旧 ~/.codex/AGENTS.md 段内容,典型表现:用户改了 codex 视角约定但 codex 子进程拿不到新内容)
  try {
    syncAgentDeckSection();
  } catch (err) {
    logger.warn('[codex-agents-md] saveUser 后 syncAgentDeckSection 失败:', err);
  }
  return { content: readFileSync(path, 'utf8'), isCustom: true };
}

/** 删除用户副本(如果存在) + invalidate cache + 同步 ~/.codex/AGENTS.md 段回到内置内容。 */
export function resetUserCodexAgentsMd(): void {
  const path = getUserCodexAgentsMdPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch (err) {
      logger.warn('[codex-agents-md] 删除用户副本失败:', err);
      throw err;
    }
  }
  invalidateCodexAgentsMdContent();
  try {
    syncAgentDeckSection();
  } catch (err) {
    logger.warn('[codex-agents-md] resetUser 后 syncAgentDeckSection 失败:', err);
  }
}

// ────────────────────────────────────────────────────────── helpers

function buildSection(content: string): string {
  return [MARKER_START, '', SECTION_BANNER, '', SECTION_HEADER, '', content.trim(), '', MARKER_END].join('\n');
}

function replaceOrAppendMarkerSection(existing: string, newSection: string): string {
  if (!existing.trim()) return newSection + '\n';
  const sectionRe = new RegExp(
    `${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`,
    'm',
  );
  if (sectionRe.test(existing)) {
    return existing.replace(sectionRe, newSection);
  }
  // 追加到末尾，前面隔一空行
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + newSection + '\n';
}

function removeMarkerSection(existing: string): string {
  if (!existing.trim()) return existing;
  const sectionRe = new RegExp(
    `\\n*${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`,
    'm',
  );
  return existing.replace(sectionRe, existing.match(sectionRe) ? '\n' : '');
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
