import { app, ipcMain, dialog, nativeImage, Notification, shell, type IpcMainInvokeEvent } from 'electron';
import { is } from '@electron-toolkit/utils';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { promises as fsp } from 'node:fs';
import { IpcInvoke } from '@shared/ipc-channels';
import { getFloatingWindow } from './window';
import { sessionManager } from './session/manager';
import { sessionRepo } from './store/session-repo';
import { eventRepo } from './store/event-repo';
import { fileChangeRepo } from './store/file-change-repo';
import { summaryRepo } from './store/summary-repo';
import { settingsStore } from './store/settings-store';
import { adapterRegistry } from './adapters/registry';
import { eventBus } from './event-bus';
import { getLifecycleScheduler } from './session/lifecycle-scheduler';
import { summarizer } from './session/summarizer';
import { playSoundOnce } from './notify/sound';
import { scanCwdSettings, getCandidatePaths } from './permissions/scanner';
import {
  getActiveAgentDeckClaudeMd,
  getBuiltinAgentDeckClaudeMd,
  invalidateAgentDeckSystemPromptAppend,
  resetUserAgentDeckClaudeMd,
  saveUserAgentDeckClaudeMd,
} from './adapters/claude-code/sdk-injection';
import type { AppSettings, ImageSource, LoadImageBlobResult } from '@shared/types';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

function on<T extends string>(channel: T, handler: Handler): void {
  ipcMain.handle(channel, handler);
}

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

export function bootstrapIpc(): void {
  on(IpcInvoke.AppGetVersion, () => app.getVersion());

  // Window
  on(IpcInvoke.WindowSetAlwaysOnTop, (_e, value) => {
    getFloatingWindow().setAlwaysOnTop(Boolean(value));
    return true;
  });
  on(IpcInvoke.WindowSetIgnoreMouse, (_e, value) => {
    getFloatingWindow().setIgnoreMouse(Boolean(value));
    return true;
  });
  on(IpcInvoke.WindowMinimize, () => {
    getFloatingWindow().window?.minimize();
    return true;
  });
  on(IpcInvoke.WindowToggleCompact, () => getFloatingWindow().toggleCompact());

  // Session
  on(IpcInvoke.SessionList, () => sessionManager.list());
  on(IpcInvoke.SessionGet, (_e, id) => sessionRepo.get(String(id)));
  on(IpcInvoke.SessionListEvents, (_e, id, limit) => {
    return eventRepo.listForSession(String(id), Number(limit ?? 200));
  });
  on(IpcInvoke.SessionListFileChanges, (_e, id) => fileChangeRepo.listForSession(String(id)));
  on(IpcInvoke.SessionListSummaries, (_e, id) => summaryRepo.listForSession(String(id)));
  on(IpcInvoke.SessionLatestSummaries, (_e, ids) => {
    const arr = Array.isArray(ids) ? (ids as unknown[]).map(String) : [];
    return summaryRepo.latestForSessions(arr);
  });
  on(IpcInvoke.SessionArchive, (_e, id) => {
    sessionManager.archive(String(id));
    return true;
  });
  on(IpcInvoke.SessionUnarchive, (_e, id) => {
    sessionManager.unarchive(String(id));
    return true;
  });
  on(IpcInvoke.SessionReactivate, (_e, id) => {
    sessionManager.reactivate(String(id));
    return true;
  });
  on(IpcInvoke.SessionDelete, (_e, id) => {
    sessionManager.delete(String(id));
    return true;
  });

  // History
  on(IpcInvoke.SessionListHistory, (_e, filters) => {
    return sessionRepo.listHistory(
      (filters ?? {}) as Parameters<typeof sessionRepo.listHistory>[0],
    );
  });

  // Hooks
  on(IpcInvoke.HookInstall, async (_e, scope, cwd) => {
    const adapter = adapterRegistry.get('claude-code');
    if (!adapter?.installIntegration) throw new Error('adapter not available');
    return adapter.installIntegration({ scope: scope as 'user' | 'project', cwd: cwd as string });
  });
  on(IpcInvoke.HookUninstall, async (_e, scope, cwd) => {
    const adapter = adapterRegistry.get('claude-code');
    if (!adapter?.uninstallIntegration) throw new Error('adapter not available');
    return adapter.uninstallIntegration({ scope: scope as 'user' | 'project', cwd: cwd as string });
  });
  on(IpcInvoke.HookStatus, async (_e, scope, cwd) => {
    const adapter = adapterRegistry.get('claude-code');
    if (!adapter?.integrationStatus) throw new Error('adapter not available');
    return adapter.integrationStatus({ scope: scope as 'user' | 'project', cwd: cwd as string });
  });

  // Settings
  on(IpcInvoke.SettingsGet, () => settingsStore.getAll());
  on(IpcInvoke.SettingsSet, (_e, patch) => {
    const p = (patch ?? {}) as Partial<AppSettings>;
    // N6 事务保护：先快照改前值，持久化后逐项 apply。任一 apply throw 时回滚 DB 到改前状态，
    // 让 UI 看到错误而不是进入「DB 改了 / 运行时半生效」的不一致状态（CHANGELOG_20）。
    const before = settingsStore.getAll();
    const next = settingsStore.patch(p);
    try {
      applyLifecycleThresholds(p, next);
      applyLoginItem(p, next);
      applyAlwaysOnTop(p, next);
      applyPermissionTimeout(p, next);
      applyCodexCliPath(p, next);
      applySummaryInterval(p, next);
      warnHookServerPort(p);
      warnHookServerToken(p);
      invalidateClaudeMdCache(p);
    } catch (err) {
      // 只回滚 patch 涉及的 key，避免动到本来就不该变的字段。
      // 双层 unknown 中转：AppSettings 严格联合类型，TS 不允许直接当 Record<string,unknown>。
      const rollback: Partial<AppSettings> = {};
      const beforeRecord = before as unknown as Record<string, unknown>;
      const rollbackRecord = rollback as unknown as Record<string, unknown>;
      for (const key of Object.keys(p)) {
        rollbackRecord[key] = beforeRecord[key];
      }
      settingsStore.patch(rollback);
      throw err;
    }
    return next;
  });

  // Adapter actions (createSession 在 M9 实现 SDK 通道后才会真正可用)
  on(IpcInvoke.AdapterList, () => {
    return adapterRegistry.list().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      capabilities: a.capabilities,
    }));
  });
  on(IpcInvoke.AdapterCreateSession, async (_e, agentId, opts) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.createSession) throw new Error('adapter cannot create session');
    const o = opts as Parameters<NonNullable<typeof adapter.createSession>>[0];
    // cwd 留空 → 兜底用户主目录。renderer 对话框允许「不填」，CLI 也共用这条兜底。
    if (!o.cwd || !String(o.cwd).trim()) {
      o.cwd = homedir();
    }
    const sid = await adapter.createSession(o);
    // 持久化 permissionMode：抽到 sessionManager.recordCreatedPermissionMode，
    // CLI 路径（cli.ts applyCliInvocation）也走同一个 helper，确保两条入口语义一致。
    sessionManager.recordCreatedPermissionMode(
      sid,
      (o as { permissionMode?: string }).permissionMode,
    );
    return sid;
  });
  on(IpcInvoke.AdapterInterrupt, async (_e, agentId, sessionId) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.interruptSession) throw new Error('adapter cannot interrupt');
    await adapter.interruptSession(String(sessionId));
    return true;
  });
  on(IpcInvoke.AdapterSendMessage, async (_e, agentId, sessionId, text) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.sendMessage) throw new Error('adapter cannot send message');
    await adapter.sendMessage(String(sessionId), String(text));
    return true;
  });
  on(IpcInvoke.AdapterRespondPermission, async (_e, agentId, sessionId, requestId, response) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.respondPermission) throw new Error('adapter cannot respond to permission');
    await adapter.respondPermission(
      String(sessionId),
      String(requestId),
      response as Parameters<NonNullable<typeof adapter.respondPermission>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterRespondAskUserQuestion, async (_e, agentId, sessionId, requestId, answer) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.respondAskUserQuestion) {
      throw new Error('adapter cannot respond to AskUserQuestion');
    }
    await adapter.respondAskUserQuestion(
      String(sessionId),
      String(requestId),
      answer as Parameters<NonNullable<typeof adapter.respondAskUserQuestion>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterRespondExitPlanMode, async (_e, agentId, sessionId, requestId, response) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.respondExitPlanMode) {
      throw new Error('adapter cannot respond to ExitPlanMode');
    }
    await adapter.respondExitPlanMode(
      String(sessionId),
      String(requestId),
      response as Parameters<NonNullable<typeof adapter.respondExitPlanMode>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterSetPermissionMode, async (_e, agentId, sessionId, mode) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.setPermissionMode) throw new Error('adapter cannot set permission mode');
    const sid = String(sessionId);
    const m = mode as Parameters<NonNullable<typeof adapter.setPermissionMode>>[1];
    await adapter.setPermissionMode(sid, m);
    // SDK 接受后持久化到 sessions 表 + 推送 upsert，让 renderer 跨切换 / 重启能恢复下拉值。
    sessionRepo.setPermissionMode(sid, m);
    const updated = sessionRepo.get(sid);
    if (updated) eventBus.emit('session-upserted', updated);
    return true;
  });

  on(IpcInvoke.AdapterListPending, (_e, agentId, sessionId) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.listPending) return { permissions: [], askQuestions: [], exitPlanModes: [] };
    return adapter.listPending(String(sessionId));
  });
  on(IpcInvoke.AdapterListPendingAll, (_e, agentId) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.listAllPending) return {};
    return adapter.listAllPending();
  });

  // Dialog
  on(IpcInvoke.DialogChooseDirectory, async (_e, defaultPath) => {
    const win = getFloatingWindow().window;
    const r = await (win
      ? dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
        })
      : dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
        }));
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  on(IpcInvoke.DialogChooseSoundFile, async (_e, defaultPath) => {
    const win = getFloatingWindow().window;
    const opts = {
      properties: ['openFile'] as ('openFile')[],
      filters: [
        { name: '音频文件', extensions: ['mp3', 'wav', 'aiff', 'aif', 'm4a', 'ogg', 'flac'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
    };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  on(IpcInvoke.DialogChooseExecutable, async (_e, defaultPath) => {
    // 选 codex 二进制路径用：macOS / Linux 的可执行文件通常无后缀，extensions: ['*']
    // 让 native dialog 不按后缀过滤；用户也可以自由选 .sh / .bin 等
    const win = getFloatingWindow().window;
    const opts = {
      properties: ['openFile'] as ('openFile')[],
      filters: [{ name: '所有文件', extensions: ['*'] }],
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
    };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  on(IpcInvoke.AppPlayTestSound, (_e, kind) => {
    const k = kind === 'waiting' || kind === 'done' ? kind : 'waiting';
    playSoundOnce(k);
    return true;
  });

  on(IpcInvoke.AppShowTestNotification, () => {
    if (!Notification.isSupported()) {
      return { ok: false, reason: 'Notification 不被当前平台/Electron 支持' };
    }
    try {
      new Notification({
        title: 'Agent Deck 测试通知',
        body: '如果你看到了这条横幅，说明系统通知正常工作。',
        silent: true,
      }).show();
      // 把 app.getName() 一并返回：dev 模式是 'Electron'，prod 是 'Agent Deck'。
      // renderer 里拼提示「请到 系统设置 → 通知 → ${appName}」时用这个值，
      // 不能写死 'Electron' —— 装好的 .app 用户去找 Electron 会找不到。
      return { ok: true, appName: app.getName() };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });

  on(IpcInvoke.DialogConfirm, async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string;
      message?: string;
      detail?: string;
      okLabel?: string;
      cancelLabel?: string;
      destructive?: boolean;
    };
    const win = getFloatingWindow().window;
    const iconPath = join(app.getAppPath(), 'resources', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    const buttons = [o.okLabel ?? '确定', o.cancelLabel ?? '取消'];
    const showOpts = {
      type: 'question' as const,
      title: o.title ?? '确认操作',
      message: o.message ?? '',
      detail: o.detail,
      buttons,
      defaultId: o.destructive ? 1 : 0,
      cancelId: 1,
      icon: icon.isEmpty() ? undefined : icon,
      noLink: true,
    };
    const r = win
      ? await dialog.showMessageBox(win, showOpts)
      : await dialog.showMessageBox(showOpts);
    return r.response === 0; // 0 = ok, 1 = cancel
  });

  // Permissions: 扫描 cwd 对应的三层 settings.json，纯只读
  on(IpcInvoke.PermissionScanCwd, async (_e, cwd) => {
    return scanCwdSettings(String(cwd ?? ''));
  });

  // Permissions: 用系统默认应用打开某个 settings.json。为防越权（renderer 传任意 path 直接 openPath），
  // 严格校验 path 必须是该 cwd 的四个候选路径之一（user / user-local / project / local）。
  on(IpcInvoke.PermissionOpenFile, async (_e, cwd, path) => {
    const candidates = getCandidatePaths(String(cwd ?? ''));
    const allowed = new Set([
      candidates.user,
      candidates.userLocal,
      candidates.project,
      candidates.local,
    ]);
    const target = String(path ?? '');
    if (!allowed.has(target)) {
      return { ok: false, reason: 'path not in candidate list' };
    }
    // shell.openPath 文件不存在时返回非空错误字符串；我们把它当作业务失败回传给前端。
    const errorMsg = await shell.openPath(target);
    return errorMsg ? { ok: false, reason: errorMsg } : { ok: true };
  });

  // CLAUDE.md（注入到 SDK system prompt 末尾的应用约定）：读 / 保存用户副本 / 重置回内置。
  // 写入位置：app.getPath('userData')/agent-deck-claude.md，用户副本覆盖内置；
  // 应用升级不冲掉自定义；保存 / 重置都会清主进程的注入缓存，下次新建会话生效。
  // 已运行的 SDK 会话已经把 system prompt 固化进 LLM 上下文，不会热改。
  on(IpcInvoke.ClaudeMdGet, () => getActiveAgentDeckClaudeMd());
  on(IpcInvoke.ClaudeMdSave, (_e, content) => {
    saveUserAgentDeckClaudeMd(String(content ?? ''));
    return { ok: true };
  });
  on(IpcInvoke.ClaudeMdReset, () => {
    resetUserAgentDeckClaudeMd();
    return { ok: true, content: getBuiltinAgentDeckClaudeMd() };
  });

  // Image: 按需读取一张图片为 dataURL 给 renderer 渲染。
  // 安全门：双白名单（path 必须出现在该 session 的 file_changes 或 tool-use-start 事件里）+ 扩展名 + size 校验。
  on(IpcInvoke.ImageLoadBlob, async (_e, sessionId, source): Promise<LoadImageBlobResult> => {
    return loadImageBlob(String(sessionId ?? ''), source as ImageSource);
  });

  // Summarizer 诊断：拉取最近一次失败原因（by sessionId）。CHANGELOG_20 / G。
  on(IpcInvoke.SummarizerLastErrors, () => summarizer.getLastErrors());
}

// ─────────────────────────────────────────────────────── Image load helpers

/** 允许 renderer 加载的图片扩展名白名单。SVG 单独算（mime 不同）。 */
const ALLOWED_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.svg',
]);
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 加载一张图片：双白名单（防 renderer 越权读任意磁盘）+ ext + size 校验。
 * 任何失败返回 { ok:false, reason }，由 UI 显示「图片不可读」灰底兜底。
 */
async function loadImageBlob(
  sessionId: string,
  source: ImageSource | null | undefined,
): Promise<LoadImageBlobResult> {
  if (!source || typeof source !== 'object') {
    return { ok: false, reason: 'unsupported_source', detail: 'source missing' };
  }
  if (source.kind !== 'path' || typeof source.path !== 'string') {
    // snapshot 形态二期再做
    return { ok: false, reason: 'unsupported_source', detail: `kind=${source.kind}` };
  }
  const reqPath = source.path;
  if (!reqPath.startsWith('/')) {
    return { ok: false, reason: 'denied', detail: 'path must be absolute' };
  }

  // TOCTOU 防护（CHANGELOG_47）：必须先 realpath 拿到 canonical 路径，再用它校验
  // 白名单 + 扩展名。否则白名单里的 symlink 可被改指向 /etc/passwd 等任意文件越权读。
  let real: string;
  try {
    real = await fsp.realpath(reqPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'enoent' };
    return { ok: false, reason: 'io_error', detail: (err as Error).message };
  }

  // 双白名单：原 reqPath 或 canonical real 至少一个曾在该 session 出现过。
  // 兼容白名单条目存的就是带 symlink 形式（旧数据）+ 拦住 symlink 跳跃越权。
  if (
    !isPathInSessionWhitelist(sessionId, reqPath) &&
    !isPathInSessionWhitelist(sessionId, real)
  ) {
    return { ok: false, reason: 'denied', detail: 'path not in session whitelist' };
  }

  // 扩展名 + MIME 都基于 canonical real：reqPath 是 .png 但 symlink 指向 .conf 的情况会被拒
  const ext = extname(real).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return { ok: false, reason: 'invalid_ext', detail: ext };
  }
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  let stat;
  try {
    stat = await fsp.stat(real);
  } catch (err) {
    return { ok: false, reason: 'io_error', detail: (err as Error).message };
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'too_big', detail: `${stat.size} bytes` };
  }
  let buf: Buffer;
  try {
    buf = await fsp.readFile(real);
  } catch (err) {
    return { ok: false, reason: 'io_error', detail: (err as Error).message };
  }
  return {
    ok: true,
    mime,
    bytes: stat.size,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
  };
}

/**
 * 判断 path 是否在该 session 的「曾出现过」白名单里。
 * 命中条件（任一）：
 * - file_changes 行的 filePath 等于 path
 * - file_changes 行的 before/after JSON 解析后是 ImageSource 且 path 等于 path
 * - 该 session 任意 tool-use-start 事件的 toolInput.file_path 等于 path
 *   （ImageRead 不进 file_changes，靠 tool-use 事件兜底）
 */
function isPathInSessionWhitelist(sessionId: string, target: string): boolean {
  if (!sessionId) return false;
  const fcs = fileChangeRepo.listForSession(sessionId);
  for (const fc of fcs) {
    if (fc.filePath === target) return true;
    for (const blob of [fc.beforeBlob, fc.afterBlob]) {
      if (!blob || typeof blob !== 'string') continue;
      // 只在 image kind 时尝试解 JSON，避免对文本 diff 的字符串误判
      if (fc.kind !== 'image') continue;
      try {
        const v = JSON.parse(blob) as { kind?: string; path?: string };
        if (v && v.kind === 'path' && v.path === target) return true;
      } catch {
        /* swallow */
      }
    }
  }
  // 兜底：ImageRead 不进 file_changes，靠 tool-use-start 事件兜底。
  // CHANGELOG_47：之前用 `listForSession(sessionId, 500)` 在 JS 侧线性扫，长会话
  // 事件 > 500 后旧图永久读不出。改走 SQL json_extract + EXISTS LIMIT 1，无视事件总数。
  if (eventRepo.hasToolUseStartWithFilePath(sessionId, target)) return true;
  return false;
}
