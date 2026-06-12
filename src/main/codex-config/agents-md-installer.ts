/**
 * Agent Deck Codex baseline management.
 *
 * Agent Deck no longer writes its bundled Codex baseline into user-level
 * `~/.codex/AGENTS.md`. In-app Codex SDK sessions receive the active
 * CODEX_AGENTS.md content through app-server `developerInstructions`.
 *
 * **plan codex-handoff-team-alignment-20260518 §D5 fallback 策略（P3 Step 3.6 修法）**:
 * 内置内容源切到 `resources/codex-config/CODEX_AGENTS.md`（codex 视角约定独立维护，不再
 * 共享 claude-config/CLAUDE.md 同一份）。
 * - codex-config/CODEX_AGENTS.md 不存在 → throw 显式 error（**禁** silent fallback 到
 *   claude-config/CLAUDE.md，避免 typecheck/build 过但运行时 codex AGENTS.md 注入静默
 *   退化到 claude 视角内容，让用户视角直到跑 codex 才发现错）
 *
 * 加载优先级（与 sdk-injection.ts 同模式）：
 * - 用户副本 `<userData>/agent-deck-codex-agents.md` → 优先（用户自定义 codex 视角约定）
 * - 内置 `resources/codex-config/CODEX_AGENTS.md` → 回落（codex 视角默认约定）
 * - 都失败 → throw（D5 fallback 策略，让 caller syncAgentDeckSection 决定是否阻断启动）
 *
 * `syncAgentDeckSection()` is retained as a compatibility cleanup hook: it only
 * removes an old Agent Deck marker section from `~/.codex/AGENTS.md` and never
 * appends a new one.
 *
 * 不实现：
 * - 双向同步（用户改 Agent Deck 段反向回 <userData>）—— D5 决策不做
 * - 外部 watch / hot reload monitor 监听 ~/.codex/AGENTS.md 外部改动（现在不再管理用户级文件）
 * - 跨进程通知 codex 在跑会话重新加载约定（app-server thread options 已在 start/resume 时锁定，
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
 * 改 CODEX_AGENTS.md 编辑器保存后调 invalidateCodexAgentsMdContent() 让下次会话注入读最新。
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
    // 调用方 try/catch 兜底转 error log(不阻断启动,但 prominent log 让
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
 * Build the in-app Codex developerInstructions payload from the active CODEX_AGENTS.md source.
 *
 * This is the per-session app-server path for Agent Deck-managed Codex SDK sessions.
 */
export function getAgentDeckCodexDeveloperInstructions(): string | undefined {
  if (!settingsStore.get('injectAgentDeckCodexAgentsMd')) return undefined;
  let content: string;
  try {
    content = getContent();
  } catch (err) {
    logger.warn('[codex-agents-md] failed to build Codex developerInstructions:', err);
    return undefined;
  }
  const substituted = substituteResourcesPlaceholder(content).trim();
  if (!substituted) return undefined;
  return `--- Agent Deck application conventions (bundled, per-session) ---\n\n${substituted}`;
}

/**
 * Cleanup an old Agent Deck marker section from ~/.codex/AGENTS.md.
 *
 * Agent Deck now injects CODEX_AGENTS.md per session through app-server
 * developerInstructions. This function never appends a section; it only removes
 * the historical managed block if present, preserving all user-authored content.
 *
 * @returns 写入后的完整文件内容（用于测试 / 调试）；跳过时返回 null
 */
export function syncAgentDeckSection(
  configPath: string = getCodexAgentsMdPath(),
): string | null {
  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch (err) {
      logger.warn(`[codex-agents-md] 读 ${configPath} 失败:`, err);
      return null;
    }
  }

  const next = removeMarkerSection(existing);
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
 * 写用户副本到 userData/agent-deck-codex-agents.md + invalidate cache。
 * 返回写盘后实际读回的内容(对偶
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
  return { content: readFileSync(path, 'utf8'), isCustom: true };
}

/** 删除用户副本(如果存在) + invalidate cache,让下次新建会话回到内置内容。 */
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
}

// ────────────────────────────────────────────────────────── helpers

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
