/**
 * Settings get/set + 9 个「即改即生效」分发 helper + ClaudeMd 三件套。
 *
 * 核心约束（保持不变）：
 * - 9 个 apply* helper 调用顺序（CHANGELOG_20 / A）
 * - SettingsSet 内 N6 事务保护（REVIEW_4 H2 / REVIEW_7 L3）：apply* 全部同步执行，
 *   任一抛错 → DB 回滚到 before + 反向 apply* 让 scheduler/loginItem/window/adapter/cache
 *   也回到 before 状态，再重抛
 * - warn* 只是 console.warn，没运行时副作用，不进 rollback
 */
import { app } from 'electron';
import { is } from '@electron-toolkit/utils';
import { IpcInvoke } from '@shared/ipc-channels';
import { getFloatingWindow } from '@main/window';
import { settingsStore } from '@main/store/settings-store';
import { adapterRegistry } from '@main/adapters/registry';
import { getLifecycleScheduler } from '@main/session/lifecycle-scheduler';
import { summarizer } from '@main/session/summarizer';
import {
  getActiveAgentDeckClaudeMd,
  getBuiltinAgentDeckClaudeMd,
  invalidateAgentDeckSystemPromptAppend,
  resetUserAgentDeckClaudeMd,
  saveUserAgentDeckClaudeMd,
} from '@main/adapters/claude-code/sdk-injection';
// NOTE(REVIEW_<X>)：以下三个 codex-config 模块**必须**走 static import，不要改回 dynamic import。
// 同一模块在多处 dynamic import（settings.ts × 3 + index.ts × 2）会让 vite SSR/rollup 把模块代码 inline
// 进主 index.js，独立 chunk 文件只剩 require 空壳没有 export → 运行时 dynamic import 拿到空对象 →
// 「X is not a function」（dev 模式 ESM 直 import 测不出，只在打包后炸）。三个模块顶部都纯 import + export
// function，无副作用，static import 与 dynamic import 等价（只是模块解析时机提前到 main 启动时）。
import { writeMcpServersToCodexConfig } from '@main/codex-config/toml-writer';
import {
  syncAgentDeckSection,
  getActiveCodexAgentsMd,
  getBuiltinCodexAgentsMd,
  saveUserCodexAgentsMd,
  resetUserCodexAgentsMd,
} from '@main/codex-config/agents-md-installer';
import { syncSkills } from '@main/codex-config/skills-installer';
import log, { setFileLevel } from '@main/utils/logger';
import type { AppSettings } from '@shared/types';
import { on, IpcInputError, parseSandboxMode, parseCodexSandboxMode } from './_helpers';

const logger = log.scope('ipc-settings');

// ─────────────────────────────────────────────────────────────────────────────
// SettingsSet 「即改即生效」分发（CHANGELOG_20 / A）。
// 9 个 helper 拆分前是 67 行单 handler 8 个 if 分支；拆后 handler 主体 ≤ 30 行，
// 每个 helper ≤ 15 行，新增设置项时只动一处。**保持调用顺序与判定条件不变**。
// ─────────────────────────────────────────────────────────────────────────────

function applyLifecycleThresholds(p: Partial<AppSettings>, next: AppSettings): void {
  if ('activeWindowMs' in p || 'closeAfterMs' in p || 'historyRetentionDays' in p) {
    getLifecycleScheduler()?.updateThresholds({
      activeWindowMs: next.activeWindowMs,
      closeAfterMs: next.closeAfterMs,
      historyRetentionDays: next.historyRetentionDays,
    });
  }
}

function applyLoginItem(p: Partial<AppSettings>, next: AppSettings): void {
  // dev 模式跳过：未签名的 Electron 二进制，macOS 13+ 直接拒绝写入登录项，
  // 错误是原生层 LOG(ERROR) 打到 stderr，try/catch 接不住。
  if (!('startOnLogin' in p) || is.dev) return;
  if (process.platform === 'darwin' || process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: next.startOnLogin,
      openAsHidden: false,
    });
  }
}

function applyAlwaysOnTop(p: Partial<AppSettings>, next: AppSettings): void {
  if ('alwaysOnTop' in p) {
    getFloatingWindow().setAlwaysOnTop(next.alwaysOnTop);
  }
}

function applyWindowTransparent(p: Partial<AppSettings>, next: AppSettings): void {
  if ('windowTransparent' in p) {
    getFloatingWindow().setWindowTransparent(next.windowTransparent);
  }
}

function applyPermissionTimeout(p: Partial<AppSettings>, next: AppSettings): void {
  if ('permissionTimeoutMs' in p) {
    adapterRegistry.get('claude-code')?.setPermissionTimeoutMs?.(next.permissionTimeoutMs);
  }
}

function applyCodexCliPath(p: Partial<AppSettings>, next: AppSettings): void {
  // 清 Codex 实例，下次新建会话用新 path。
  if ('codexCliPath' in p) {
    adapterRegistry.get('codex-cli')?.setCodexCliPath?.(next.codexCliPath);
  }
}

function applyClaudeCliPath(p: Partial<AppSettings>, _next: AppSettings): void {
  // plan add-claude-cli-path-override-and-bump-sdks-20260520 §设计决策 D6:claude SDK 不持
  // instance pool / per-session bridge cache,不需 invalidate。占位 if-block 与 codexCliPath
  // 对称(读者一眼看出对称结构),body 留空 — sdk-bridge/index.ts:253 + claude-runner.ts:55 每次
  // createSession 重新 settingsStore.get('claudeCliPath'),即改即生效(下次 createSession 用新路径)。
  // 已 spawn 中的 SDK 子进程已经把 binary path 喂给 cli.js,setting 改了不会回滚已跑会话(N6)。
  if ('claudeCliPath' in p) {
    // 故意 no-op:见上方注释。symmetry-plan 同款思路 — 读者一眼看出 codex 与 claude apply 链对称。
  }
}

/**
 * symmetry-plan P2 MED-B：codex sandbox 切档不再需要 apply hook。
 *
 * 修法前：bridge 持 `private currentSandboxMode` field 当 settings 镜像，settings 改 →
 * `applyCodexSandboxMode` push 到 bridge → bridge createSession 用 field。修法后：bridge
 * createSession 改为直接 `settingsStore.get('codexSandbox')` 直读，与 claude-code adapter
 * `sdk-bridge/sandbox-resolve.ts` 同款直读模式 — 删 in-memory mirror + setter + apply hook
 * 三层冗余,降配置回路复杂度。「切档仅下次新建会话生效」语义不变（spawn-time 锁定,与
 * claudeCodeSandbox 同模式）。
 */

/**
 * CHANGELOG_<X> A4b：codexMcpServers 改了 → 把 Agent Deck 自管的 mcp_servers 段
 * 同步写到 ~/.codex/config.toml（marker 包裹 / atomic write，不破坏用户其他段）。
 *
 * 即改即生效**对下次新建 codex 会话**：codex 子进程 startThread 时按当时
 * config.toml 加载 mcp_servers 配置，已在跑的 thread 不撤销（与 codexSandbox /
 * claudeCodeSandbox 同模式：spawn-time options 不可热切）。
 *
 * 写盘失败只 warn，不阻断 settings 保存（settings DB 一定要先写，让 UI 状态稳定；
 * 写 codex config 失败用户可以手动重试 / 看 console 日志）。
 */
function applyCodexMcpServers(p: Partial<AppSettings>, next: AppSettings): void {
  if (!('codexMcpServers' in p)) return;
  try {
    writeMcpServersToCodexConfig(next.codexMcpServers);
  } catch (err) {
    logger.warn('[settings] writeMcpServersToCodexConfig 失败', err);
  }
}

/**
 * CHANGELOG_<X> D1：injectAgentDeckCodexAgentsMd 改了 → 同步 Agent Deck 段到
 * ~/.codex/AGENTS.md（marker 包裹）。开 → 写入；关 → 移除段（保留用户内容）。
 *
 * 与 applyCodexMcpServers 同模式：spawn-time options（codex 不支持热重载 AGENTS.md），
 * 改后**下次新建 codex 会话**生效。
 */
function applyCodexAgentsMd(p: Partial<AppSettings>, _next: AppSettings): void {
  if (!('injectAgentDeckCodexAgentsMd' in p)) return;
  try {
    syncAgentDeckSection();
  } catch (err) {
    logger.warn('[settings] syncAgentDeckSection 失败', err);
  }
}

/**
 * CHANGELOG_<X> D2：injectAgentDeckCodexSkills 改了 → 同步内置 skills 到
 * ~/.codex/skills/agent-deck/。开 → 镜像；关 → 移除整个 agent-deck/ 目录
 * （保留用户其他 skills）。
 */
function applyCodexSkills(p: Partial<AppSettings>, _next: AppSettings): void {
  if (!('injectAgentDeckCodexSkills' in p)) return;
  try {
    syncSkills();
  } catch (err) {
    logger.warn('[settings] syncSkills 失败', err);
  }
}

function applySummaryInterval(p: Partial<AppSettings>, next: AppSettings): void {
  // summaryTimeoutMs / summaryEventCount / summaryMaxConcurrent 是每轮 scanAll
  // 内部读 settings 的，天生即时生效，不需要在这里分发。只 interval 需重启 setInterval。
  if ('summaryIntervalMs' in p) {
    summarizer.setIntervalMs(next.summaryIntervalMs);
  }
}

function applyLogLevel(p: Partial<AppSettings>, next: AppSettings): void {
  // Plan runtime-logging-electron-log-20260529 §D4 §D14 §Step 3.1.3:
  // 只更新 file transport, console transport 永远 'silly' 不变 (dev terminal 看全部输出)。
  if ('logLevel' in p) {
    setFileLevel(next.logLevel);
  }
}

function warnHookServerPort(p: Partial<AppSettings>): void {
  // 监听端口在 server 已 listen 后无法热切换；hook curl 命令端口也会与新值不一致。
  // 两个问题都需要重启应用 + 重新点 install hook 才能完整生效。UI 已标「（重启生效）」。
  if ('hookServerPort' in p) {
    logger.warn(
      '[settings] hookServerPort changed; restart app + reinstall hooks to take effect',
    );
  }
}

function warnHookServerToken(p: Partial<AppSettings>): void {
  // N8 补：原 SettingsSet handler 漏判 hookServerToken 分支，UI 暂未暴露 token 编辑入口，
  // 但 plan A 重构时务必同时加上避免 silent fail（CHANGELOG_20）。
  // 同 hookServerPort：换 token 必须重启 server + 重新 install hook 才能生效。
  if ('hookServerToken' in p) {
    logger.warn(
      '[settings] hookServerToken changed; restart app + reinstall hooks to take effect',
    );
  }
}

function invalidateClaudeMdCache(p: Partial<AppSettings>): void {
  // 注入开关本身在 sdk-injection 入口处独立检查，但 cache 仍可能持有「true 时读到的内容」，
  // 关掉再开会让用户副本/内置切换瞬间生效。
  if ('injectAgentDeckClaudeMd' in p) {
    invalidateAgentDeckSystemPromptAppend();
  }
}

export function registerSettingsIpc(): void {
  on(IpcInvoke.SettingsGet, () => settingsStore.getAll());
  on(IpcInvoke.SettingsSet, (_e, patch) => {
    if (patch !== undefined && (patch === null || typeof patch !== 'object' || Array.isArray(patch))) {
      throw new IpcInputError('patch', 'must be plain object');
    }
    const p = (patch ?? {}) as Partial<AppSettings>;
    // per-field 白名单校验：claudeCodeSandbox 是 union type，避免 renderer 传非法字符串
    // 静默存入 store 后 sdk-bridge 时拿到「不属于三档之一」的值导致沙盒装配混乱。
    // 走 parseSandboxMode（同 parsePermissionMode 模式）：null → 调用方决定是否兜底，
    // 非白名单 → throw IpcInputError 让 renderer 显错。
    if ('claudeCodeSandbox' in p) {
      const validated = parseSandboxMode(p.claudeCodeSandbox);
      // null（renderer 传 null / undefined 想清空字段）→ 兜底回默认 'off'
      p.claudeCodeSandbox = validated ?? 'off';
    }
    // codexSandbox 同模式：null 兜底回默认 'workspace-write'（与 codex 历史硬编码值一致）
    if ('codexSandbox' in p) {
      const validated = parseCodexSandboxMode(p.codexSandbox);
      p.codexSandbox = validated ?? 'workspace-write';
    }
    // N6 事务保护：先快照改前值，持久化后逐项 apply。任一 apply throw 时回滚 DB **和运行时**
    // 到改前状态（REVIEW_4 H2：旧版只回 DB，apply* 已动 scheduler/loginItem/window/adapter/cache，
    // 留在「DB 退了 + 运行时半生效」正是注释要避免的状态）。
    const before = settingsStore.getAll();
    const next = settingsStore.patch(p);
    // REVIEW_7 L3：apply / rollback 函数列表统一来源。旧版分别在 try / catch 里手写两份对称
    // 列表，新增 setting 字段时易漏 apply 导致「能改但不生效」。warn* 没运行时副作用，
    // 不进 rollback，单独跑。
    const APPLY_FNS = [
      applyLifecycleThresholds,
      applyLoginItem,
      applyAlwaysOnTop,
      applyWindowTransparent,
      applyPermissionTimeout,
      applyCodexCliPath,
      applyClaudeCliPath,
      applyCodexMcpServers,
      applyCodexAgentsMd,
      applyCodexSkills,
      applySummaryInterval,
      applyLogLevel,
      invalidateClaudeMdCache,
    ] as const;
    try {
      for (const fn of APPLY_FNS) fn(p, next);
      warnHookServerPort(p);
      warnHookServerToken(p);
    } catch (err) {
      // 1) DB 回滚：只回 patch 涉及的 key，避免动到本来就不该变的字段。
      //    双层 unknown 中转：AppSettings 严格联合类型，TS 不允许直接当 Record<string,unknown>。
      const rollback: Partial<AppSettings> = {};
      const beforeRecord = before as unknown as Record<string, unknown>;
      const rollbackRecord = rollback as unknown as Record<string, unknown>;
      for (const key of Object.keys(p)) {
        rollbackRecord[key] = beforeRecord[key];
      }
      settingsStore.patch(rollback);
      // 2) 运行时回滚：再跑一遍 apply* 链让 scheduler/loginItem/window/adapter 实例/cache
      //    退到 before 状态。每个 apply 单独 try/catch，避免一个回滚函数抛错把后续都吞掉。
      for (const fn of APPLY_FNS) {
        try {
          fn(rollback, before);
        } catch (rollbackErr) {
          logger.error('[settings] rollback apply* failed:', rollbackErr);
        }
      }
      throw err;
    }
    return next;
  });

  // CLAUDE.md（注入到 SDK system prompt 末尾的应用约定）：读 / 保存用户副本 / 重置回内置。
  // 写入位置：app.getPath('userData')/agent-deck-claude.md，用户副本覆盖内置；
  // 应用升级不冲掉自定义；保存 / 重置都会清主进程的注入缓存，下次新建会话生效。
  // 已运行的 SDK 会话已经把 system prompt 固化进 LLM 上下文，不会热改。
  on(IpcInvoke.ClaudeMdGet, () => getActiveAgentDeckClaudeMd());
  on(IpcInvoke.ClaudeMdSave, (_e, content) => {
    if (typeof content !== 'string') {
      throw new IpcInputError('content', 'must be string');
    }
    // 上限 2MB —— 远超合理 CLAUDE.md 体量（< 100KB），防 renderer 误传二进制 / 巨量 JSON
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
      throw new IpcInputError('content', '> 2MB');
    }
    return saveUserAgentDeckClaudeMd(content);
  });
  on(IpcInvoke.ClaudeMdReset, () => {
    resetUserAgentDeckClaudeMd();
    return { ok: true, content: getBuiltinAgentDeckClaudeMd() };
  });

  // CODEX_AGENTS.md(注入到 ~/.codex/AGENTS.md Agent Deck 段的 codex 视角应用约定):
  // 与 ClaudeMd Get/Save/Reset 对偶。save / reset 内部触发 syncAgentDeckSection 立即同步
  // ~/.codex/AGENTS.md(否则用户改了用户副本但 codex SDK 仍读旧 cache)。
  // 已运行的 codex SDK 会话已经把 AGENTS.md 固化进 thread system prompt,不会热改;只有
  // 「下次新建会话」生效(对偶 ClaudeMd 同模式)。
  on(IpcInvoke.CodexAgentsMdGet, () => getActiveCodexAgentsMd());
  on(IpcInvoke.CodexAgentsMdSave, (_e, content) => {
    if (typeof content !== 'string') {
      throw new IpcInputError('content', 'must be string');
    }
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
      throw new IpcInputError('content', '> 2MB');
    }
    return saveUserCodexAgentsMd(content);
  });
  on(IpcInvoke.CodexAgentsMdReset, () => {
    resetUserCodexAgentsMd();
    return { ok: true, content: getBuiltinCodexAgentsMd() };
  });
}
