/**
 * IPC 通道常量。Renderer ↔ Main 之间的所有通信都使用这些字符串。
 * 命名规范：<scope>:<verb>。invoke = 请求-响应；event = main → renderer 单向推送。
 */

export const IpcInvoke = {
  AppGetVersion: 'app:get-version',
  WindowSetAlwaysOnTop: 'window:set-always-on-top',
  WindowSetIgnoreMouse: 'window:set-ignore-mouse',
  WindowMinimize: 'window:minimize',
  WindowToggleCompact: 'window:toggle-compact',
  SessionList: 'session:list',
  SessionListHistory: 'session:list-history',
  SessionGet: 'session:get',
  SessionArchive: 'session:archive',
  SessionUnarchive: 'session:unarchive',
  SessionDelete: 'session:delete',
  SessionReactivate: 'session:reactivate',
  SessionListEvents: 'session:list-events',
  SessionListFileChanges: 'session:list-file-changes',
  SessionListSummaries: 'session:list-summaries',
  SessionLatestSummaries: 'session:latest-summaries',
  HookInstall: 'hook:install',
  HookUninstall: 'hook:uninstall',
  HookStatus: 'hook:status',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  AdapterCreateSession: 'adapter:create-session',
  AdapterInterrupt: 'adapter:interrupt',
  AdapterSendMessage: 'adapter:send-message',
  AdapterRespondPermission: 'adapter:respond-permission',
  AdapterRespondAskUserQuestion: 'adapter:respond-ask-user-question',
  AdapterRespondExitPlanMode: 'adapter:respond-exit-plan-mode',
  AdapterSetPermissionMode: 'adapter:set-permission-mode',
  AdapterListPending: 'adapter:list-pending',
  AdapterListPendingAll: 'adapter:list-pending-all',
  AdapterList: 'adapter:list',
  DialogChooseDirectory: 'dialog:choose-directory',
  DialogChooseSoundFile: 'dialog:choose-sound-file',
  /** 选择可执行文件路径（用于「Codex 二进制路径」设置项）；filter 设为「无后缀 / 任意文件」 */
  DialogChooseExecutable: 'dialog:choose-executable',
  AppPlayTestSound: 'app:play-test-sound',
  AppShowTestNotification: 'app:show-test-notification',
  DialogConfirm: 'dialog:confirm',
  /** 扫描 cwd 对应的三层 Claude Code settings（user / project / local），返回原文 + 合并视图 */
  PermissionScanCwd: 'permission:scan-cwd',
  /** 用系统默认应用打开 settings 文件；为防越权，main 端会校验 path 必须是该 cwd 的三个候选路径之一 */
  PermissionOpenFile: 'permission:open-file',
  /**
   * 按需读取一张图片为 dataURL 供 renderer 渲染。
   * 主进程做白名单（path 必须出现在该 session 的 file_changes / tool-use-start 事件里）+ 扩展名 + 大小校验，
   * 防止 renderer 越权读任意磁盘文件。失败不抛错，返回 { ok:false, reason }。
   */
  ImageLoadBlob: 'image:load-blob',
  /** 读取注入到 SDK system prompt 末尾的 agent-deck CLAUDE.md（用户副本优先 → 回落内置）。 */
  ClaudeMdGet: 'claude-md:get',
  /** 保存用户副本 CLAUDE.md 到 userData 目录，并清主进程注入缓存（下次新建会话生效）。 */
  ClaudeMdSave: 'claude-md:save',
  /** 删除用户副本 CLAUDE.md（如果存在），回落到内置版本，并清缓存。 */
  ClaudeMdReset: 'claude-md:reset',
} as const;

export const IpcEvent = {
  AgentEvent: 'event:agent',
  SessionUpserted: 'event:session-upserted',
  SessionRemoved: 'event:session-removed',
  /** SDK fallback 路径：sessionId 从 tempKey 切到真实 SDK session_id 时触发，
   *  让 renderer 把 selectedId / 各 by-session map 整体迁移，不被踢回主界面。 */
  SessionRenamed: 'event:session-renamed',
  SummaryAdded: 'event:summary-added',
  PinToggled: 'event:pin-toggled',
  /** CLI 新建会话后让 renderer 切到「实时」并选中该 sessionId（避免用户找不到新会话）。 */
  SessionFocusRequest: 'event:session-focus-request',
} as const;

export type IpcInvokeChannel = (typeof IpcInvoke)[keyof typeof IpcInvoke];
export type IpcEventChannel = (typeof IpcEvent)[keyof typeof IpcEvent];
