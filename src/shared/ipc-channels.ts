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
  AdapterRestartWithCodexSandbox: 'adapter:restart-with-codex-sandbox',
  AdapterRestartWithClaudeCodeSandbox: 'adapter:restart-with-claude-code-sandbox',
  AdapterListPending: 'adapter:list-pending',
  AdapterListPendingAll: 'adapter:list-pending-all',
  AdapterList: 'adapter:list',
  DialogChooseDirectory: 'dialog:choose-directory',
  DialogChooseSoundFile: 'dialog:choose-sound-file',
  DialogChooseExecutable: 'dialog:choose-executable',
  AppPlayTestSound: 'app:play-test-sound',
  AppShowTestNotification: 'app:show-test-notification',
  DialogConfirm: 'dialog:confirm',
  PermissionScanCwd: 'permission:scan-cwd',
  PermissionOpenFile: 'permission:open-file',
  ImageLoadBlob: 'image:load-blob',
  UploadedImageLoad: 'image:load-uploaded',
  ClaudeMdGet: 'claude-md:get',
  ClaudeMdSave: 'claude-md:save',
  ClaudeMdReset: 'claude-md:reset',
  SummarizerLastErrors: 'summarizer:last-errors',

  // ─────────── R3.E8 — Agent Deck universal team backend (替代老 team:* channel) ───────────
  /** 列出 active team（默认隐藏 archived）。返回 AgentDeckTeam[]（裸，不含 members）。 */
  AgentDeckTeamList: 'agent-deck-team:list',
  /** 拉一个 team 完整 snapshot：含 members + 最近 messages。返回 null = team 不存在。 */
  AgentDeckTeamGet: 'agent-deck-team:get',
  /** 显式建 team（UI / CLI 入口）。args: { name, metadata? }，返回 AgentDeckTeam。 */
  AgentDeckTeamCreate: 'agent-deck-team:create',
  /** 归档 team（标 archived_at；不删数据）。已 enqueued pending message 仍投递完成。 */
  AgentDeckTeamArchive: 'agent-deck-team:archive',
  /** 取消归档（如有 active 同名 team 抛错）。args: teamId。 */
  AgentDeckTeamUnarchive: 'agent-deck-team:unarchive',
  /** 加 member 到 team。args: { teamId, sessionId, role, displayName? }。 */
  AgentDeckTeamAddMember: 'agent-deck-team:add-member',
  /** member 离开 team（写 left_at；不删 row）。args: { teamId, sessionId }。 */
  AgentDeckTeamRemoveMember: 'agent-deck-team:remove-member',
  /** 显式发 cross-adapter team message。args: { teamId, fromSessionId, toSessionId, body }。 */
  AgentDeckTeamSendMessage: 'agent-deck-team:send-message',
  /** 拉一个 team 的近期消息流（默认 100 条 ORDER BY sent_at DESC）。 */
  AgentDeckMessageListByTeam: 'agent-deck-message:list-by-team',
  /** 显式 cancel 一条 pending / delivering message。args: { messageId, reason? }。 */
  AgentDeckMessageCancel: 'agent-deck-message:cancel',
  /** 拉指定 team 的 SQLite tasks（替代老 TaskListByTeam）。args: teamId。 */
  TaskListByTeam: 'task:list-by-team',

  // ─────────── Assets Library (CHANGELOG_57) ───────────
  AssetsListBundled: 'assets:list-bundled',
  AssetsListUser: 'assets:list-user',
  AssetsGetContent: 'assets:get-content',
  AssetsSaveUser: 'assets:save-user',
  AssetsDeleteUser: 'assets:delete-user',
  AssetsRevealInFolder: 'assets:reveal',
} as const;

export const IpcEvent = {
  AgentEvent: 'event:agent',
  SessionUpserted: 'event:session-upserted',
  SessionRemoved: 'event:session-removed',
  SessionRenamed: 'event:session-renamed',
  SummaryAdded: 'event:summary-added',
  PinToggled: 'event:pin-toggled',
  TransparentToggled: 'event:transparent-toggled',
  SessionFocusRequest: 'event:session-focus-request',
  /** Task Manager (CHANGELOG_43)：tasks 表写操作 after-commit 推送。 */
  TaskChanged: 'event:task-changed',

  // ─────────── R3.E9 — Agent Deck universal team backend events ───────────
  /** team 增删改 / member 改：聚合数组 payload，16ms debounce + per-team 累加。 */
  AgentDeckTeamChanged: 'event:agent-deck-team-changed',
  /** message 入队 / 状态变迁：聚合数组 payload，16ms debounce + per-message 累加。 */
  AgentDeckMessageChanged: 'event:agent-deck-message-changed',
} as const;

export type IpcInvokeChannel = (typeof IpcInvoke)[keyof typeof IpcInvoke];
export type IpcEventChannel = (typeof IpcEvent)[keyof typeof IpcEvent];
