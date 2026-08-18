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
 * - 都失败 → throw（D5 fallback 策略，由会话注入入口降级并记录错误）
 *
 * 不实现：
 * - 双向同步（用户改 Agent Deck 段反向回 <userData>）—— D5 决策不做
 * - 外部 watch / hot reload monitor 监听 ~/.codex/AGENTS.md 外部改动（现在不再管理用户级文件）
 * - 跨进程通知 codex 在跑会话重新加载约定（app-server thread options 已在 start/resume 时锁定，
 *   下次新建会话生效，与 sdk-injection.ts 同模式）
 */
import { join } from 'node:path';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';
import log from '@main/utils/logger';
import { getApplicationResourcesRoot } from '@main/runtime-host/application-resources';
import { getApplicationHostPaths } from '@main/runtime-host/application-paths';
import {
  createCodexAgentsMdStore,
  type CodexAgentsMdStore,
} from './agents-md-store';

const logger = log.scope('codex-agents-md');

const USER_AGENTS_MD_FILENAME = 'agent-deck-codex-agents.md';
let cachedStore:
  | {
      builtinPath: string;
      userPath: string;
      store: CodexAgentsMdStore;
    }
  | undefined;

function getStore(): CodexAgentsMdStore {
  const builtinPath = join(
    getApplicationResourcesRoot(),
    'codex-config',
    'CODEX_AGENTS.md',
  );
  const userPath = join(
    getApplicationHostPaths().userDataPath,
    USER_AGENTS_MD_FILENAME,
  );
  if (cachedStore?.builtinPath === builtinPath && cachedStore.userPath === userPath) {
    return cachedStore.store;
  }
  const store = createCodexAgentsMdStore({
    builtinPath,
    userPath,
    diagnostics: { warn: (message, error) => logger.warn(message, error) },
  });
  cachedStore = { builtinPath, userPath, store };
  return store;
}

/**
 * Build the in-app Codex developerInstructions payload from the active CODEX_AGENTS.md source.
 *
 * The active source is the user copy when present and the bundled Codex baseline otherwise. The
 * store invalidates its cache after saving or resetting the user copy.
 */
export function getAgentDeckCodexDeveloperInstructions(): string | undefined {
  if (!settingsStore.get('injectAgentDeckCodexAgentsMd')) return undefined;
  let content: string;
  try {
    content = getStore().getContent();
  } catch (err) {
    logger.warn('[codex-agents-md] failed to build Codex developerInstructions:', err);
    return undefined;
  }
  const substituted = substituteResourcesPlaceholder(content).trim();
  if (!substituted) return undefined;
  return `--- Agent Deck application conventions (bundled, per-session) ---\n\n${substituted}`;
}

/**
 * 读取「当前生效」的 codex CODEX_AGENTS.md 原文(不含 marker / banner / header,只是 raw markdown
 * 内容主体),给设置面板用。isCustom = true 表示当前是用户副本,false 表示回落到内置。
 *
 * 与 sdk-injection.ts:getActiveAgentDeckClaudeMd 对偶 — claude 副本在 `<userData>/agent-deck-claude.md`,
 * codex 副本在 `<userData>/agent-deck-codex-agents.md`,两份独立文件互不影响。
 */
export function getActiveCodexAgentsMd(): { content: string; isCustom: boolean } {
  return getStore().getActive();
}

/** 永远读内置 codex-config/CODEX_AGENTS.md,给「恢复默认」按钮用。读不到返回空串 + warn。 */
export function getBuiltinCodexAgentsMd(): string {
  return getStore().getBuiltin();
}

/**
 * 写用户副本到 userData/agent-deck-codex-agents.md + invalidate cache。
 * 返回写盘后实际读回的内容(对偶
 * sdk-injection.ts:saveUserAgentDeckClaudeMd REVIEW_4 M11 修法,防 main 端规范化让 dirty 永真)。
 *
 * 原子写: write tmp + rename(对偶 sdk-injection saveUserAgentDeckClaudeMd / hook-installer.writeSettings)。
 */
export function saveUserCodexAgentsMd(content: string): { content: string; isCustom: true } {
  const saved = getStore().saveUser(content);
  return { content: saved.content, isCustom: true };
}

/** 删除用户副本(如果存在) + invalidate cache,让下次新建会话回到内置内容。 */
export function resetUserCodexAgentsMd(): void {
  getStore().resetUser();
}
