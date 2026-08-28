/** Renderer ↔ Main IPC contract. Channel changes require synchronized endpoints. */

export const IpcInvoke = {
  AppGetVersion: 'app:get-version',
  WindowSetAlwaysOnTop: 'window:set-always-on-top',
  WindowSetIgnoreMouse: 'window:set-ignore-mouse',
  WindowMinimize: 'window:minimize',
  WindowToggleCompact: 'window:toggle-compact',
  SessionList: 'session:list',
  SessionListHistory: 'session:list-history',
  SessionGet: 'session:get',
  SessionTakePendingFocus: 'session:take-pending-focus',
  SessionArchive: 'session:archive',
  SessionUnarchive: 'session:unarchive',
  SessionDelete: 'session:delete',
  SessionReactivate: 'session:reactivate',
  SessionSetPinned: 'session:set-pinned',
  SessionListEvents: 'session:list-events',
  SessionListFileChangePage: 'session:list-file-change-page',
  SessionGetFileChange: 'session:get-file-change',
  SessionGetFileFinalDiff: 'session:get-file-final-diff',
  SessionGetGitBranch: 'session:get-git-branch',
  SessionListSummaries: 'session:list-summaries',
  SessionLatestSummaries: 'session:latest-summaries',
  /** 拉某 session 视角可见的 SQLite tasks：own personal tasks + active-team tasks。 */
  SessionListTasks: 'session:list-tasks',
  /** 冻结源事件边界、生成器和目标 runtime，并在 main 保留完整会话续接上下文。 */
  SessionHandOffPrepare: 'session:hand-off-prepare',
  /** 仅凭 owner-bound preparation id 创建 successor；renderer 不回传或改写 capsule。 */
  SessionHandOffCommit: 'session:hand-off-commit',
  /** 取消未提交的 preparation，并同步清理 main-side TEMP spool。 */
  SessionHandOffCancel: 'session:hand-off-cancel',
  HookInstall: 'hook:install',
  HookUninstall: 'hook:uninstall',
  HookStatus: 'hook:status',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  AdapterCreateSession: 'adapter:create-session',
  AdapterSessionCreationDefaults: 'adapter:session-creation-defaults',
  AdapterInterrupt: 'adapter:interrupt',
  AdapterSendMessage: 'adapter:send-message',
  AdapterListSessionCommands: 'adapter:list-session-commands',
  AdapterListPendingOutgoing: 'adapter:list-pending-outgoing',
  AdapterLoadPendingOutgoingAttachment: 'adapter:load-pending-outgoing-attachment',
  AdapterDeletePendingOutgoing: 'adapter:delete-pending-outgoing',
  AdapterSteerTurn: 'adapter:steer-turn',
  AdapterRespondPermission: 'adapter:respond-permission',
  AdapterRespondAskUserQuestion: 'adapter:respond-ask-user-question',
  AdapterRespondExitPlanMode: 'adapter:respond-exit-plan-mode',
  AdapterRespondDiffReview: 'adapter:respond-diff-review',
  PlanReviewStartDeepReview: 'plan-review:start-deep-review',
  PlanReviewAskDeepReview: 'plan-review:ask-deep-review',
  PlanReviewGenerateFeedback: 'plan-review:generate-feedback',
  AdapterSetPermissionMode: 'adapter:set-permission-mode',
  AdapterSetSessionMode: 'adapter:set-session-mode',
  AdapterSetSessionModelOptions: 'adapter:set-session-model-options',
  AdapterSetCodexApprovalPolicy: 'adapter:set-codex-approval-policy',
  AdapterSetCodexSandbox: 'adapter:set-codex-sandbox',
  AdapterRestartWithClaudeCodeSandbox: 'adapter:restart-with-claude-code-sandbox',
  AdapterRestartWithGrokSandbox: 'adapter:restart-with-grok-sandbox',
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
  PermissionScanCodex: 'permission:scan-codex',
  PermissionOpenCodexFile: 'permission:open-codex-file',
  ImageLoadBlob: 'image:load-blob',
  UploadedImageLoad: 'image:load-uploaded',
  ClaudeMdGet: 'claude-md:get',
  ClaudeMdSave: 'claude-md:save',
  ClaudeMdReset: 'claude-md:reset',
  CodexAgentsMdGet: 'codex-agents-md:get',
  CodexAgentsMdSave: 'codex-agents-md:save',
  CodexAgentsMdReset: 'codex-agents-md:reset',
  GrokAgentsMdGet: 'grok-agents-md:get',
  GrokAgentsMdSave: 'grok-agents-md:save',
  GrokAgentsMdReset: 'grok-agents-md:reset',
  GrokAuthProbe: 'grok-auth:probe',
  SummarizerLastErrors: 'summarizer:last-errors',

  // Session-scoped in-app Browser state and native view presentation.
  BrowserStateGet: 'browser:state-get',
  BrowserPresentationBegin: 'browser:presentation-begin',
  BrowserPresentationUpdate: 'browser:presentation-update',
  BrowserPresentationSelect: 'browser:presentation-select',
  BrowserPresentationClose: 'browser:presentation-close',
  BrowserPresentationPark: 'browser:presentation-park',
  BrowserAnnotationCapture: 'browser:annotation-capture',

  // Issue Tracker UI channels are separate from agent-facing MCP tools.
  IssuesList: 'issues:list',
  IssuesGet: 'issues:get',
  IssuesUpdate: 'issues:update',
  IssuesSoftDelete: 'issues:soft-delete',
  IssuesUndelete: 'issues:undelete',
  IssuesResolveInNewSession: 'issues:resolve-in-new-session',

  // Token usage statistics.
  /** 各 model bucket 在最近 WINDOW_MS 窗口的 output 总量（renderer 算 token/s = out ÷ 窗口秒）。 */
  TokenUsageRates: 'token-usage:rates',
  /** 今日各 model bucket output 总量降序（Top3 header + 数据页今日汇总）。 */
  TokenUsageTopToday: 'token-usage:top-today',
  /** model bucket × 本地日期的统一 token 账本（数据 tab 表格）。 */
  TokenUsageDaily: 'token-usage:daily',
  /** Claude / Codex 订阅窗口用量快照（数据 tab）。 */
  ProviderUsageSnapshot: 'provider-usage:snapshot',

  // Session collaboration message projection.
  /** List cross-session messages sent or received by one session. */
  AgentDeckMessageListBySession: 'agent-deck-message:list-by-session',

  // Assets library.
  AssetsListBundled: 'assets:list-bundled',
  AssetsListUser: 'assets:list-user',
  AssetsGetContent: 'assets:get-content',
  AssetsRevealInFolder: 'assets:reveal',
  AssetsSaveBundledAgentRuntime: 'assets:save-bundled-agent-runtime',
  AssetsResetBundledAgentRuntime: 'assets:reset-bundled-agent-runtime',
  AssetsListClaudeGatewayProfiles: 'assets:list-claude-gateway-profiles',
  AssetsListCodexGatewayProfiles: 'assets:list-codex-gateway-profiles',

  // Runtime logging.
  /** Settings LogsSection 「打开日志目录」 — shell.openPath(app.getPath('logs')). */
  LogsOpenDirectory: 'logs:open-directory',
  /** Settings LogsSection 「显示日志」 — 读当天 main-YYYY-MM-DD.log 文本供应用内 Monaco 只读查看;
   * 文件不存在返 { ok:true, existed:false }; 文件 > 2MB 读尾部 2MB + truncated:true (防 Monaco/IPC 撑爆). */
  LogsReadToday: 'logs:read-today',
  /** Settings LogsSection 「清空今天日志」 — truncate main-YYYY-MM-DD.log; fallback: 文件不存在
   * 时 no-op + 返回 false 让 UI 弹 toast「今天还没有日志可清空」. */
  LogsTruncateToday: 'logs:truncate-today',
  /** Fire-and-forget preload fatal error report: { message, stack? }. */
  PreloadFatalError: 'preload:fatal-error',
} as const;

/** Typed current Desktop-host surface for Remote connection and product operations. */
export const RemoteHostIpcInvoke = {
  Snapshot: 'remote-host:snapshot',
  ProfileAdd: 'remote-host:profile-add',
  ProfileUpdate: 'remote-host:profile-update',
  ProfileRemove: 'remote-host:profile-remove',
  ProfileSelect: 'remote-host:profile-select',
  SourceModeSet: 'remote-host:source-mode-set',
  Connect: 'remote-host:connect',
  Disconnect: 'remote-host:disconnect',
  ChooseConnection: 'remote-host:choose-connection',
  SessionPresentationsList: 'remote-host:session-presentations-list',
  SessionGet: 'remote-host:session-get',
  SessionCapabilities: 'remote-host:session-capabilities',
  WorkspaceDirectoriesList: 'remote-host:workspace-directories-list',
  WorkspaceDirectoryCreate: 'remote-host:workspace-directory-create',
  ProjectsList: 'remote-host:projects-list',
  SessionCreate: 'remote-host:session-create',
  SessionArchive: 'remote-host:session-archive',
  SessionUnarchive: 'remote-host:session-unarchive',
  SessionReactivate: 'remote-host:session-reactivate',
  SessionDelete: 'remote-host:session-delete',
  HistoryList: 'remote-host:history-list',
  EventsList: 'remote-host:events-list',
  SummariesList: 'remote-host:summaries-list',
  TasksList: 'remote-host:tasks-list',
  UsageTokensGet: 'remote-host:usage-tokens-get',
  UsageProvidersGet: 'remote-host:usage-providers-get',
  NodeConfigurationGet: 'remote-host:node-configuration-get',
  NodeHookStatus: 'remote-host:node-hook-status',
  NodeHookInstall: 'remote-host:node-hook-install',
  NodeHookUninstall: 'remote-host:node-hook-uninstall',
  NodeAssetsList: 'remote-host:node-assets-list',
  NodeAssetContentGet: 'remote-host:node-asset-content-get',
  NodeAssetConventionGet: 'remote-host:node-asset-convention-get',
  IssuesList: 'remote-host:issues-list',
  IssueGet: 'remote-host:issue-get',
  IssueUpdate: 'remote-host:issue-update',
  IssueSoftDelete: 'remote-host:issue-soft-delete',
  IssueUndelete: 'remote-host:issue-undelete',
  IssueResolveInNewSession: 'remote-host:issue-resolve-in-new-session',
  FileChangesList: 'remote-host:file-changes-list',
  FileChangeGet: 'remote-host:file-change-get',
  FileFinalDiffGet: 'remote-host:file-final-diff-get',
  ImageAssetLoad: 'remote-host:image-asset-load',
  SessionSend: 'remote-host:session-send',
  SessionInterrupt: 'remote-host:session-interrupt',
  SessionSteer: 'remote-host:session-steer',
  SessionContextGet: 'remote-host:session-context-get',
  SessionInputCapabilities: 'remote-host:session-input-capabilities',
  SessionMessagesList: 'remote-host:session-messages-list',
  SessionOutgoingList: 'remote-host:session-outgoing-list',
  SessionOutgoingRemove: 'remote-host:session-outgoing-remove',
  SessionHandOffPreview: 'remote-host:session-handoff-preview',
  SessionHandOffCommit: 'remote-host:session-handoff-commit',
  PendingList: 'remote-host:pending-list',
  PendingIndexList: 'remote-host:pending-index-list',
  PendingRespond: 'remote-host:pending-respond',
  PlanReviewStart: 'remote-host:plan-review-start',
  PlanReviewAsk: 'remote-host:plan-review-ask',
  PlanReviewFeedback: 'remote-host:plan-review-feedback',
  RuntimeGet: 'remote-host:runtime-get',
  RuntimeUpdate: 'remote-host:runtime-update',
} as const;

export const IpcEvent = {
  AgentEvent: 'event:agent',
  SessionUpserted: 'event:session-upserted',
  SessionRemoved: 'event:session-removed',
  SessionRenamed: 'event:session-renamed',
  SummaryAdded: 'event:summary-added',
  PinToggled: 'event:pin-toggled',
  TransparentToggled: 'event:transparent-toggled',
  /** Synchronizes renderer compact state after external window-size changes. */
  CompactToggled: 'event:compact-toggled',
  SessionFocusRequest: 'event:session-focus-request',
  /** Emitted after a task write commits. */
  TaskChanged: 'event:task-changed',
  /** Emitted after an issue write commits; hard deletes retain sourceSessionId. */
  IssueChanged: 'event:issue-changed',
  /** Token usage commit notification: { sessionId, ts }. */
  TokenUsageChanged: 'event:token-usage-changed',
  /** Display-only token-rate estimate; it is not persisted. */
  TokenRateTick: 'event:token-rate-tick',
  /** Reports caller archive failures from archive and hand-off operations. */
  CallerArchiveFailed: 'event:caller-archive-failed',
  /** Redacted invalidation signal; renderer refreshes typed business snapshots via invoke. */
  RemoteHostChanged: 'event:remote-host-changed',

  /** Source-qualified Browser tab metadata; never contains the private engine owner id. */
  BrowserStateChanged: 'event:browser-state-changed',

  /** message 入队 / 状态变迁：聚合数组 payload，16ms debounce + per-message 累加。 */
  AgentDeckMessageChanged: 'event:agent-deck-message-changed',
} as const;
