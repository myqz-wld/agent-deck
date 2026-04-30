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
import type { AppSettings } from '@shared/types';
import { on, IpcInputError, parseSandboxMode } from './_helpers';

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

function applyTransparentWhenPinned(p: Partial<AppSettings>, next: AppSettings): void {
  if ('transparentWhenPinned' in p) {
    getFloatingWindow().setTransparentWhenPinned(next.transparentWhenPinned);
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

function applySummaryInterval(p: Partial<AppSettings>, next: AppSettings): void {
  // summaryTimeoutMs / summaryEventCount / summaryMaxConcurrent 是每轮 scanAll
  // 内部读 settings 的，天生即时生效，不需要在这里分发。只 interval 需重启 setInterval。
  if ('summaryIntervalMs' in p) {
    summarizer.setIntervalMs(next.summaryIntervalMs);
  }
}

function warnHookServerPort(p: Partial<AppSettings>): void {
  // 监听端口在 server 已 listen 后无法热切换；hook curl 命令端口也会与新值不一致。
  // 两个问题都需要重启应用 + 重新点 install hook 才能完整生效。UI 已标「（重启生效）」。
  if ('hookServerPort' in p) {
    console.warn(
      '[settings] hookServerPort changed; restart app + reinstall hooks to take effect',
    );
  }
}

function warnHookServerToken(p: Partial<AppSettings>): void {
  // N8 补：原 SettingsSet handler 漏判 hookServerToken 分支，UI 暂未暴露 token 编辑入口，
  // 但 plan A 重构时务必同时加上避免 silent fail（CHANGELOG_20）。
  // 同 hookServerPort：换 token 必须重启 server + 重新 install hook 才能生效。
  if ('hookServerToken' in p) {
    console.warn(
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
      applyTransparentWhenPinned,
      applyPermissionTimeout,
      applyCodexCliPath,
      applySummaryInterval,
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
          console.error('[settings] rollback apply* failed:', rollbackErr);
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
}
