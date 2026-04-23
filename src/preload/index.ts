import { contextBridge, ipcRenderer } from 'electron';
import { IpcInvoke, IpcEvent } from '@shared/ipc-channels';
import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ImageSource,
  LoadImageBlobResult,
  PermissionRequest,
  PermissionResponse,
  PermissionScanResult,
  SessionRecord,
  SummaryRecord,
} from '@shared/types';

const api = {
  // 应用
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IpcInvoke.AppGetVersion),

  // 窗口
  setAlwaysOnTop: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.WindowSetAlwaysOnTop, value),
  setIgnoreMouse: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.WindowSetIgnoreMouse, value),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IpcInvoke.WindowMinimize),
  toggleCompact: (): Promise<boolean> => ipcRenderer.invoke(IpcInvoke.WindowToggleCompact),

  // 会话
  listSessions: (): Promise<SessionRecord[]> => ipcRenderer.invoke(IpcInvoke.SessionList),
  /**
   * 历史会话列表（含 closed 与归档）。filters 字段透传给 sessionRepo.listHistory。
   * 此前曾走 window.electronIpc.invoke 兜底通道，typo 不会被 TS 拦截 → silent fail；
   * 改为强类型 facade 后 channel 名就只有这一处真值。
   */
  listSessionHistory: (filters: {
    agentId?: string;
    cwd?: string;
    fromTs?: number;
    toTs?: number;
    keyword?: string;
    archivedOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<SessionRecord[]> => ipcRenderer.invoke(IpcInvoke.SessionListHistory, filters),
  getSession: (id: string): Promise<SessionRecord | null> =>
    ipcRenderer.invoke(IpcInvoke.SessionGet, id),
  archiveSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionArchive, id),
  unarchiveSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionUnarchive, id),
  reactivateSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionReactivate, id),
  deleteSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionDelete, id),
  listEvents: (id: string, limit?: number): Promise<AgentEvent[]> =>
    ipcRenderer.invoke(IpcInvoke.SessionListEvents, id, limit),
  listFileChanges: (id: string): Promise<unknown[]> =>
    ipcRenderer.invoke(IpcInvoke.SessionListFileChanges, id),
  listSummaries: (id: string): Promise<SummaryRecord[]> =>
    ipcRenderer.invoke(IpcInvoke.SessionListSummaries, id),
  latestSummaries: (ids: string[]): Promise<Record<string, SummaryRecord>> =>
    ipcRenderer.invoke(IpcInvoke.SessionLatestSummaries, ids),

  // Hook
  installHook: (scope: 'user' | 'project', cwd?: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcInvoke.HookInstall, scope, cwd),
  uninstallHook: (scope: 'user' | 'project', cwd?: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcInvoke.HookUninstall, scope, cwd),
  hookStatus: (scope: 'user' | 'project', cwd?: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcInvoke.HookStatus, scope, cwd),

  // 设置
  getSettings: (): Promise<unknown> => ipcRenderer.invoke(IpcInvoke.SettingsGet),
  setSettings: (patch: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke(IpcInvoke.SettingsSet, patch),

  // Adapter
  listAdapters: (): Promise<{ id: string; displayName: string; capabilities: Record<string, boolean> }[]> =>
    ipcRenderer.invoke(IpcInvoke.AdapterList),
  createAdapterSession: (agentId: string, opts: Record<string, unknown>): Promise<string> =>
    ipcRenderer.invoke(IpcInvoke.AdapterCreateSession, agentId, opts),
  interruptAdapterSession: (agentId: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterInterrupt, agentId, sessionId),
  sendAdapterMessage: (agentId: string, sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSendMessage, agentId, sessionId, text),
  respondPermission: (
    agentId: string,
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterRespondPermission, agentId, sessionId, requestId, response),
  respondAskUserQuestion: (
    agentId: string,
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<void> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRespondAskUserQuestion,
      agentId,
      sessionId,
      requestId,
      answer,
    ),
  respondExitPlanMode: (
    agentId: string,
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRespondExitPlanMode,
      agentId,
      sessionId,
      requestId,
      response,
    ),
  setAdapterPermissionMode: (
    agentId: string,
    sessionId: string,
    mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSetPermissionMode, agentId, sessionId, mode),

  /** 拉取主进程 SDK 当前还在等的 pending 请求；renderer HMR / 重启后用来重建 store。 */
  listAdapterPending: (
    agentId: string,
    sessionId: string,
  ): Promise<{
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  }> => ipcRenderer.invoke(IpcInvoke.AdapterListPending, agentId, sessionId),
  listAdapterPendingAll: (
    agentId: string,
  ): Promise<
    Record<
      string,
      {
        permissions: PermissionRequest[];
        askQuestions: AskUserQuestionRequest[];
        exitPlanModes: ExitPlanModeRequest[];
      }
    >
  > => ipcRenderer.invoke(IpcInvoke.AdapterListPendingAll, agentId),

  // Dialog
  chooseDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcInvoke.DialogChooseDirectory, defaultPath),
  chooseSoundFile: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcInvoke.DialogChooseSoundFile, defaultPath),
  /** 选择可执行文件（用于设置面板「Codex 二进制路径」） */
  chooseExecutableFile: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcInvoke.DialogChooseExecutable, defaultPath),

  // App helpers
  playTestSound: (kind: 'waiting' | 'done'): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AppPlayTestSound, kind),
  showTestNotification: (): Promise<{ ok: boolean; reason?: string; appName?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AppShowTestNotification),
  confirmDialog: (opts: {
    title?: string;
    message?: string;
    detail?: string;
    okLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }): Promise<boolean> => ipcRenderer.invoke(IpcInvoke.DialogConfirm, opts),

  /** 扫描会话 cwd 对应的三层 Claude Code settings.json，返回原文 + 合并视图 */
  scanCwdSettings: (cwd: string): Promise<PermissionScanResult> =>
    ipcRenderer.invoke(IpcInvoke.PermissionScanCwd, cwd),
  /** 用系统默认应用打开 settings 文件；main 端会校验 path 必须是该 cwd 的候选路径之一 */
  openPermissionFile: (
    cwd: string,
    path: string,
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.PermissionOpenFile, cwd, path),

  /**
   * 按需读取一张 mcp 图片工具产生的图片为 dataURL（main 进程做白名单 + ext + size 校验）。
   * 仅支持 path 形态的 ImageSource；任何失败返回 { ok:false, reason }，由 UI 显示「图片不可读」灰底兜底。
   */
  loadImageBlob: (sessionId: string, source: ImageSource): Promise<LoadImageBlobResult> =>
    ipcRenderer.invoke(IpcInvoke.ImageLoadBlob, sessionId, source),

  // 事件订阅
  onAgentEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const handler = (_: unknown, e: AgentEvent): void => cb(e);
    ipcRenderer.on(IpcEvent.AgentEvent, handler);
    return () => ipcRenderer.off(IpcEvent.AgentEvent, handler);
  },
  onSessionUpserted: (cb: (s: SessionRecord) => void): (() => void) => {
    const handler = (_: unknown, s: SessionRecord): void => cb(s);
    ipcRenderer.on(IpcEvent.SessionUpserted, handler);
    return () => ipcRenderer.off(IpcEvent.SessionUpserted, handler);
  },
  onSessionRemoved: (cb: (id: string) => void): (() => void) => {
    const handler = (_: unknown, id: string): void => cb(id);
    ipcRenderer.on(IpcEvent.SessionRemoved, handler);
    return () => ipcRenderer.off(IpcEvent.SessionRemoved, handler);
  },
  onSessionRenamed: (cb: (p: { from: string; to: string }) => void): (() => void) => {
    const handler = (_: unknown, p: { from: string; to: string }): void => cb(p);
    ipcRenderer.on(IpcEvent.SessionRenamed, handler);
    return () => ipcRenderer.off(IpcEvent.SessionRenamed, handler);
  },
  onSummaryAdded: (cb: (s: SummaryRecord) => void): (() => void) => {
    const handler = (_: unknown, s: SummaryRecord): void => cb(s);
    ipcRenderer.on(IpcEvent.SummaryAdded, handler);
    return () => ipcRenderer.off(IpcEvent.SummaryAdded, handler);
  },
  onPinToggled: (cb: (pinned: boolean) => void): (() => void) => {
    const handler = (_: unknown, pinned: boolean): void => cb(pinned);
    ipcRenderer.on(IpcEvent.PinToggled, handler);
    return () => ipcRenderer.off(IpcEvent.PinToggled, handler);
  },
  onSessionFocusRequest: (cb: (sessionId: string) => void): (() => void) => {
    const handler = (_: unknown, sessionId: string): void => cb(sessionId);
    ipcRenderer.on(IpcEvent.SessionFocusRequest, handler);
    return () => ipcRenderer.off(IpcEvent.SessionFocusRequest, handler);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
    contextBridge.exposeInMainWorld('electronIpc', {
      invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
        ipcRenderer.invoke(channel, ...args),
    });
  } catch (e) {
    console.error(e);
  }
} else {
  (window as unknown as { api: typeof api }).api = api;
  (window as unknown as { electronIpc: unknown }).electronIpc = {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke(channel, ...args),
  };
}

export type AgentDeckApi = typeof api;
