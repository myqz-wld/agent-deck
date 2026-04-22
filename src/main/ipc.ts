import { app, ipcMain, dialog, nativeImage, Notification, shell, type IpcMainInvokeEvent } from 'electron';
import { is } from '@electron-toolkit/utils';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
import { playSoundOnce } from './notify/sound';
import { scanCwdSettings, getCandidatePaths } from './permissions/scanner';
import type { AppSettings } from '@shared/types';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

function on<T extends string>(channel: T, handler: Handler): void {
  ipcMain.handle(channel, handler);
}

export function bootstrapIpc(): void {
  on(IpcInvoke.AppGetVersion, () => process.env.npm_package_version ?? '0.1.0');

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

  // History (overload SessionList by accepting filters)
  ipcMain.handle('session:list-history', (_e, filters) => {
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
    const next = settingsStore.patch(p);

    // 把变更立刻应用到运行时模块；面板里的开关从此可以「即改即生效」。

    // 1) 生命周期阈值 → LifecycleScheduler
    if ('activeWindowMs' in p || 'closeAfterMs' in p) {
      getLifecycleScheduler()?.updateThresholds({
        activeWindowMs: next.activeWindowMs,
        closeAfterMs: next.closeAfterMs,
      });
    }

    // 2) 开机自启 → 立即写系统登录项（dev 模式跳过：未签名的 Electron 二进制写不进去）
    if ('startOnLogin' in p && !is.dev) {
      if (process.platform === 'darwin' || process.platform === 'win32') {
        app.setLoginItemSettings({
          openAtLogin: next.startOnLogin,
          openAsHidden: false,
        });
      }
    }

    // 3) 始终置顶 → 立即应用到窗口（同时 header 的 pin 按钮也会读 settings 同步）
    if ('alwaysOnTop' in p) {
      getFloatingWindow().setAlwaysOnTop(next.alwaysOnTop);
    }

    // 4) 权限超时 → 同步给 ClaudeCode adapter（影响后续新建 pending 的 timer）
    if ('permissionTimeoutMs' in p) {
      const adapter = adapterRegistry.get('claude-code');
      adapter?.setPermissionTimeoutMs?.(next.permissionTimeoutMs);
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
    // SDK 通道：把新建对话框里选的 permissionMode 持久化到 sessions.permission_mode 列，
    // 否则 SessionDetail 底部下拉只会读到 NULL → 'default'，跟实际 SDK 状态对不上。
    // 'default' 等价于不设（不污染 CLI 通道的列），其他值（acceptEdits/plan/bypassPermissions）才写入。
    const pm = (o as { permissionMode?: string }).permissionMode;
    if (pm && pm !== 'default') {
      sessionRepo.setPermissionMode(sid, pm as Parameters<typeof sessionRepo.setPermissionMode>[1]);
      const updated = sessionRepo.get(sid);
      if (updated) eventBus.emit('session-upserted', updated);
    }
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
  // 严格校验 path 必须是该 cwd 的三个候选路径之一（user / project / local）。
  on(IpcInvoke.PermissionOpenFile, async (_e, cwd, path) => {
    const candidates = getCandidatePaths(String(cwd ?? ''));
    const allowed = new Set([candidates.user, candidates.project, candidates.local]);
    const target = String(path ?? '');
    if (!allowed.has(target)) {
      return { ok: false, reason: 'path not in candidate list' };
    }
    // shell.openPath 文件不存在时返回非空错误字符串；我们把它当作业务失败回传给前端。
    const errorMsg = await shell.openPath(target);
    return errorMsg ? { ok: false, reason: errorMsg } : { ok: true };
  });
}
