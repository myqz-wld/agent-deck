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
  AdapterSetPermissionMode: 'adapter:set-permission-mode',
  AdapterListPending: 'adapter:list-pending',
  AdapterListPendingAll: 'adapter:list-pending-all',
  AdapterList: 'adapter:list',
  DialogChooseDirectory: 'dialog:choose-directory',
  DialogChooseSoundFile: 'dialog:choose-sound-file',
  AppPlayTestSound: 'app:play-test-sound',
  AppShowTestNotification: 'app:show-test-notification',
  DialogConfirm: 'dialog:confirm',
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
