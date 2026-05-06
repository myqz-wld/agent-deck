import { contextBridge, ipcRenderer } from 'electron';
import { IpcInvoke, IpcEvent } from '@shared/ipc-channels';
import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  AssetContentResult,
  AssetKind,
  AssetSource,
  BundledAssetsSnapshot,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ImageSource,
  LoadImageBlobResult,
  PermissionRequest,
  PermissionResponse,
  PermissionScanResult,
  SessionRecord,
  SummaryRecord,
  TaskChangedEvent,
  TaskRecord,
  TeamDataChangedEvent,
  TeamPermissionDecision,
  TeamPermissionRequest,
  TeamSnapshot,
  TeamSummary,
  UserAssetInput,
  UserAssetsSnapshot,
} from '@shared/types';

const api = {
  // 应用
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IpcInvoke.AppGetVersion),

  /**
   * 当前进程平台（CHANGELOG_57）。preload 进程能直接读 `process.platform` 全局
   * （与 contextIsolated 无关——process 是 Node 注入），常量值启动后永不变 →
   * 静态字段暴露，不必走 ipcRenderer.invoke。renderer 用 `src/renderer/lib/platform.ts`
   * 的 `IS_DARWIN/IS_WIN/IS_LINUX` 包装消费。
   */
  platform: process.platform as NodeJS.Platform,

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

  // CLAUDE.md（注入到 SDK system prompt 末尾的 agent-deck 应用约定）
  /** 读取「当前生效」的 CLAUDE.md（用户副本优先 → 回落内置）。 */
  getClaudeMd: (): Promise<{ content: string; isCustom: boolean }> =>
    ipcRenderer.invoke(IpcInvoke.ClaudeMdGet),
  /** 保存用户副本到 userData/agent-deck-claude.md（清缓存，下次新建会话生效）。
   *  返回 main 写盘后**实际读回**的内容（REVIEW_4 M11：让 renderer 用真实内容更新 loaded
   *  避免 main 端规范化后 dirty 永真）。 */
  saveClaudeMd: (content: string): Promise<{ content: string; isCustom: true }> =>
    ipcRenderer.invoke(IpcInvoke.ClaudeMdSave, content),
  /** 删除用户副本回落内置；返回新的内置内容供 UI 同步刷新。 */
  resetClaudeMd: (): Promise<{ ok: boolean; content: string }> =>
    ipcRenderer.invoke(IpcInvoke.ClaudeMdReset),

  // ─────────── Assets Library (CHANGELOG_57) ───────────
  /** 列内置 plugin agents+skills（main 启动时一次性扫 frontmatter，缓存读）。 */
  listBundledAssets: (): Promise<BundledAssetsSnapshot> =>
    ipcRenderer.invoke(IpcInvoke.AssetsListBundled),
  /** 列用户自定义 ~/.claude/{agents,skills}/ 下全部资产；每次现扫现读。 */
  listUserAssets: (): Promise<UserAssetsSnapshot> =>
    ipcRenderer.invoke(IpcInvoke.AssetsListUser),
  /** 读单个 asset 完整 md 文本（含 frontmatter + body）。「查看完整内容」/ 编辑器 mount 用。 */
  getAssetContent: (
    kind: AssetKind,
    name: string,
    source: AssetSource,
  ): Promise<AssetContentResult> =>
    ipcRenderer.invoke(IpcInvoke.AssetsGetContent, kind, name, source),
  /** 保存用户 asset；main 端拼装 frontmatter + 原子写。返回写盘后的 AssetMeta。 */
  saveUserAsset: (input: UserAssetInput): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsSaveUser, input),
  /** 删除用户 asset。skill 子目录递归 rm，agent 单文件 unlink。 */
  deleteUserAsset: (
    kind: AssetKind,
    name: string,
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsDeleteUser, kind, name),
  /** 在 Finder / 资源管理器中显示对应文件，跨平台。 */
  revealAssetInFolder: (
    kind: AssetKind,
    name: string,
    source: AssetSource,
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsRevealInFolder, kind, name, source),

  /**
   * 拉取 summarizer 最近一次失败原因（by sessionId），UI 设置面板诊断用。
   * 空对象表示没有任何会话失败过（CHANGELOG_20 / G）。
   */
  summarizerLastErrors: (): Promise<Record<string, { message: string; ts: number }>> =>
    ipcRenderer.invoke(IpcInvoke.SummarizerLastErrors),

  // ─────────── Agent Teams (M2) ───────────
  /** 列出所有 team 简表（合并 SQL distinctTeamNames + fs ~/.claude/teams/）。 */
  listTeams: (): Promise<TeamSummary[]> => ipcRenderer.invoke(IpcInvoke.TeamList),
  /** 拉一个 team 的完整 snapshot（sessions + config.json + task list + events）；name 不存在仍返回空 snapshot。 */
  getTeam: (name: string): Promise<TeamSnapshot | null> =>
    ipcRenderer.invoke(IpcInvoke.TeamGet, name),
  /** Agent Teams M3：手动清理一个 team 的 fs 残留（rm -rf 两个目录）+ 主动 unset 该 team 名下所有 sessions 的 team_name。返回实际删掉的目录数 + 解绑的 session 数。 */
  forceCleanupTeam: (name: string): Promise<{ removed: string[]; unsetSessions: number }> =>
    ipcRenderer.invoke(IpcInvoke.TeamForceCleanup, name),
  /** 拉指定 team 的结构化 SQLite tasks（mcp__tasks__* 工具写入），TeamDetail 「结构化 tasks」section 用。
   *  限 200 条。订阅 onTaskChanged 后重拉。 */
  listTeamTasks: (name: string): Promise<{ tasks: TaskRecord[] }> =>
    ipcRenderer.invoke(IpcInvoke.TaskListByTeam, name),
  /**
   * 订阅某 team 的 fs 变化（chokidar 引用计数 +1）。返回 unsubscribe 闭包：
   * 调用时既触发 `TeamUnsubscribe` IPC（引用计数 -1，60s grace 后真 close），
   * 也 detach 本地 ipcRenderer listener（避免 leak）。
   *
   * onChange 仅在该 team 名匹配时触发——所有 team 共享同一个 IPC channel，靠 payload.name 过滤。
   */
  subscribeTeam: (
    name: string,
    onChange: (payload: TeamDataChangedEvent) => void,
  ): (() => void) => {
    const handler = (_: unknown, payload: TeamDataChangedEvent): void => {
      if (payload.name === name) onChange(payload);
    };
    ipcRenderer.on(IpcEvent.TeamDataChanged, handler);
    void ipcRenderer.invoke(IpcInvoke.TeamSubscribe, name).catch((err) => {
      // subscribe 失败不阻塞 renderer，仅 console.warn；listener 已加自然不会触发
      console.warn(`[preload] subscribeTeam(${name}) failed:`, err);
    });
    return () => {
      ipcRenderer.off(IpcEvent.TeamDataChanged, handler);
      void ipcRenderer.invoke(IpcInvoke.TeamUnsubscribe, name).catch(() => {
        /* swallow: 已 unmount，再 warn 也没意义 */
      });
    };
  },

  // ─────────── Agent Teams in-process backend permission inbox (CHANGELOG_45) ───────────
  /**
   * 订阅某 team 的 inbox 文件 fs 监听（chokidar 引用计数 +1）。
   * onPermissionRequest 仅在该 team 名匹配时触发——所有 team 共享 IpcEvent.TeamPermissionRequested
   * 通道，靠 payload.teamName 过滤。
   *
   * 注意：应用层 main bootstrap 已经按 active session 自动订阅一份，UI 这里订阅是补强
   * + 让 grace 期内切回视图能立刻见到旧 watcher 重用。unmount unsubscribe 不会真 close
   * 直到自动订阅那份也释放（refcount 共享）。
   */
  subscribeTeamInbox: (
    name: string,
    onPermissionRequest: (req: TeamPermissionRequest) => void,
  ): (() => void) => {
    const reqHandler = (_: unknown, req: TeamPermissionRequest): void => {
      if (req.teamName === name) onPermissionRequest(req);
    };
    ipcRenderer.on(IpcEvent.TeamPermissionRequested, reqHandler);
    void ipcRenderer.invoke(IpcInvoke.TeamSubscribeInbox, name).catch((err) => {
      console.warn(`[preload] subscribeTeamInbox(${name}) failed:`, err);
    });
    return () => {
      ipcRenderer.off(IpcEvent.TeamPermissionRequested, reqHandler);
      void ipcRenderer.invoke(IpcInvoke.TeamUnsubscribeInbox, name).catch(() => {
        /* swallow */
      });
    };
  },
  /** 写 permission_response 文本到 teammate inbox 文件，response 决定是 success / error。 */
  respondTeamPermission: (
    teamName: string,
    fromMemberSlug: string,
    requestId: string,
    decision: TeamPermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): Promise<{ ok: true }> =>
    ipcRenderer.invoke(
      IpcInvoke.TeamRespondPermission,
      teamName,
      fromMemberSlug,
      requestId,
      decision,
      updatedInput ?? null,
    ),
  /** UI 收到 team-permission-resolved 事件后清掉本地 pending 列表。 */
  onTeamPermissionResolved: (
    cb: (p: { teamName: string; requestId: string }) => void,
  ): (() => void) => {
    const handler = (_: unknown, p: { teamName: string; requestId: string }): void => cb(p);
    ipcRenderer.on(IpcEvent.TeamPermissionResolved, handler);
    return () => ipcRenderer.off(IpcEvent.TeamPermissionResolved, handler);
  },

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
  /**
   * Task Manager (CHANGELOG_43)：订阅 tasks 写操作（create/update/delete）after-commit
   * 推送。当前 renderer 没 task UI 消费此事件（Layer A+B only），但基础设施有了，未来
   * 加 Tasks tab 直接 onTaskChanged 订阅即可（与 onTeamDataChanged 同模式）。
   */
  onTaskChanged: (cb: (e: TaskChangedEvent) => void): (() => void) => {
    const handler = (_: unknown, e: TaskChangedEvent): void => cb(e);
    ipcRenderer.on(IpcEvent.TaskChanged, handler);
    return () => ipcRenderer.off(IpcEvent.TaskChanged, handler);
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
