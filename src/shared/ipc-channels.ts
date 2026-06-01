/**
 * **shared/** category: **contract**（跨进程通信契约 — IPC 通道字符串常量）。
 *
 * IPC 通道常量。Renderer ↔ Main 之间的所有通信都使用这些字符串。
 * 命名规范：<scope>:<verb>。invoke = 请求-响应；event = main → renderer 单向推送。
 *
 * **shared/ 边界约定**（R37 P3-J Step 4.7 加 jsdoc 标签）：
 * - **contract**: 跨进程通信形式 + 数据 schema（IPC 通道名 / domain types / 序列化 contract），
 *   改动属破坏性变更需双端同步（main + renderer），typecheck 自动覆盖
 * - **policy**: 跨进程共享的业务规则 / 识别 / 解析逻辑（如 wire prefix parser / 图片工具识别 /
 *   read-only tool 白名单），改动属业务行为变更，需评估对 main + renderer 行为的统一影响
 *
 * 本文件属 **contract**。
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
  /**
   * K3 hand-off Stage 1（plan mcp-bug-and-feature-batch-20260513 Phase 4c）：拉历史 →
   * LLM oneshot 生成「目标 / 已做 / 下一步 / 相关文件」结构化接力简报，返回供 renderer
   * 在 modal preview / 编辑后再确认。失败 throw → renderer 显示 inline error 让用户重试。
   */
  SessionHandOffSummarize: 'session:hand-off-summarize',
  /**
   * K3 hand-off Stage 2：用 finalPrompt（用户在 modal 可能已编辑）起新 SDK session（adapter
   * / cwd / permissionMode 沿用原 session）+ 自动归档原 session（archive 失败仅 warn 不阻
   * 塞 newSid 返回，让用户至少能切到新 session 工作）。
   */
  SessionHandOffSpawn: 'session:hand-off-spawn',
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
  CodexAgentsMdGet: 'codex-agents-md:get',
  CodexAgentsMdSave: 'codex-agents-md:save',
  CodexAgentsMdReset: 'codex-agents-md:reset',
  SummarizerLastErrors: 'summarizer:last-errors',

  // ─────────── Issue Tracker (plan issue-tracker-mcp-20260529 §Step 3.5.4) ───────────
  /**
   * 6 个 IPC channel 给 UI Issues tab 用（agent 不消费这些 — 与 mcp tool 路径正交）。
   *
   * **§不变量 1**: agent 走 mcp tool 写 issue（report_issue / append_issue_context / update_issue_status，
   * 3 个 write）；其中 update_issue_status 让源 / 解决会话能自助改 status，其余 read/admin（list / get /
   * 软删等）全部走本组 IPC channel 给 UI 用。两套通道完全隔离。
   *
   * `IssuesResolveInNewSession` 走 D14 选定路径 (b) — `adapter.createSession(buildCreateSessionOptions(...))`
   * 绕过 mcp tool 层 spawn-guards 三道防御（UI 触发不是 agent spawn agent，不适用）；
   * spawn 完后 `issueRepo.update(id, {resolutionSessionId: sid, status: 'in-progress'})`。
   */
  IssuesList: 'issues:list',
  IssuesGet: 'issues:get',
  IssuesUpdate: 'issues:update',
  IssuesSoftDelete: 'issues:soft-delete',
  IssuesUndelete: 'issues:undelete',
  IssuesResolveInNewSession: 'issues:resolve-in-new-session',

  // ─────────── R3.E8 — Agent Deck universal team backend (替代老 team:* channel) ───────────
  /** 列出 active team（默认隐藏 archived）。返回 AgentDeckTeam[]（裸，不含 members）。 */
  AgentDeckTeamList: 'agent-deck-team:list',
  /** 拉一个 team 完整 snapshot：含 members + 最近 messages。返回 null = team 不存在。 */
  AgentDeckTeamGet: 'agent-deck-team:get',
  /**
   * plan team-cohesion-fix-20260513 Phase C：拉一个 team 的 4 sections snapshot：
   * { team, members, recentEvents (50 条), tasks, recentMessages (100 条) }。
   * lineage 与 pending 由 renderer 端从 sessions Map / store pendingXBySession 自拼，
   * 避免重复 SQL + 与 PendingTab 数据源同步。返回 null = team 不存在。
   */
  AgentDeckTeamGetFull: 'agent-deck-team:get-full',
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
  /**
   * plan team-cohesion-fix-20260513 Phase F D7：批量 close team 内**仅 teammate role**
   * 的 active 成员（lead 不动）。返回 { closed: string[], failed: { sessionId, reason }[] }。
   */
  AgentDeckTeamShutdownAllTeammates: 'agent-deck-team:shutdown-all-teammates',
  /** 显式发 cross-adapter team message。args: { teamId, fromSessionId, toSessionId, body }。 */
  AgentDeckTeamSendMessage: 'agent-deck-team:send-message',
  /** 拉一个 team 的近期消息流（默认 100 条 ORDER BY sent_at DESC）。 */
  AgentDeckMessageListByTeam: 'agent-deck-message:list-by-team',
  /**
   * plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2：拉某 session 涉及的 cross-session
   * messages（from_session_id = sid OR to_session_id = sid）。SessionDetail 「跨会话消息」tab
   * 兜底视图：J fix 后 reply 不再 inject 给 sender SDK，此 channel 给 lead 一个 DB 视角
   * 全量补回。args: { sessionId, limit?, offset? }，返回 AgentDeckMessage[]。
   */
  AgentDeckMessageListBySession: 'agent-deck-message:list-by-session',
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

  // ─────────── Runtime Logging (Plan runtime-logging-electron-log-20260529 §D9 §Step 3.2) ───────────
  /** Settings LogsSection 「打开日志目录」 — shell.openPath(app.getPath('logs')). */
  LogsOpenDirectory: 'logs:open-directory',
  /** Settings LogsSection 「显示日志」 — 读当天 main-YYYY-MM-DD.log 文本供应用内 Monaco 只读查看;
   * 文件不存在返 { ok:true, existed:false }; 文件 > 2MB 读尾部 2MB + truncated:true (防 Monaco/IPC 撑爆). */
  LogsReadToday: 'logs:read-today',
  /** Settings LogsSection 「清空今天日志」 — truncate main-YYYY-MM-DD.log; fallback: 文件不存在
   * 时 no-op + 返回 false 让 UI 弹 toast「今天还没有日志可清空」. */
  LogsTruncateToday: 'logs:truncate-today',
  /**
   * Preload fatal error 上报通道(Plan §Step 3.2.6 follow-up, CHANGELOG_179) — preload 端
   * `contextBridge.exposeInMainWorld('api', api)` 失败时 ipcRenderer.send(...) 让 main 端
   * `ipcMain.on(...)` 接住落 logger.scope('preload-fatal').error(...). 与 webContents.on
   * ('preload-error') 互补:本 channel 拦 preload 加载成功后内部 throw / preload-error 拦
   * preload script 本身加载失败(语法错 / asar 路径错 / require 失败). fire-and-forget 不需
   * 要 main 端 ack(用 ipcRenderer.send + ipcMain.on 而非 invoke/handle).
   *
   * payload: { message: string; stack?: string }
   */
  PreloadFatalError: 'preload:fatal-error',
} as const;

export const IpcEvent = {
  AgentEvent: 'event:agent',
  SessionUpserted: 'event:session-upserted',
  SessionRemoved: 'event:session-removed',
  SessionRenamed: 'event:session-renamed',
  SummaryAdded: 'event:summary-added',
  PinToggled: 'event:pin-toggled',
  TransparentToggled: 'event:transparent-toggled',
  /** CHANGELOG_124 R1 fix REVIEW_45 MED-1：toggleMaximize / toggleDefault 退出 compact 态时
   *  emit 让 renderer 把本地 `compact` state 翻回 false，避免按钮 label `{compact ? '▢' : '─'}`
   *  与实际窗口尺寸反转（用户先点 ▢ 折叠 → 按 Cmd+Alt+= 后窗口实际 max 但按钮仍显示 ▢）。 */
  CompactToggled: 'event:compact-toggled',
  SessionFocusRequest: 'event:session-focus-request',
  /** Task Manager (CHANGELOG_43)：tasks 表写操作 after-commit 推送。 */
  TaskChanged: 'event:task-changed',
  /**
   * Issue Tracker (plan issue-tracker-mcp-20260529 §Step 3.4.3)：issues 表写操作 after-commit 推送。
   *
   * payload schema = IssueChangedEvent (src/shared/types/issue.ts):
   *   { kind: 'created'|'updated'|'appended'|'softDeleted'|'undeleted'|'hardDeleted',
   *     issueId: string, issue: IssueRecord | null, sourceSessionId: string | null, ts: number }
   *
   * 触发：mcp report_issue / append_issue_context handler + IPC IssuesUpdate / IssuesSoftDelete /
   * IssuesUndelete / IssuesResolveInNewSession handler + IssueLifecycleScheduler tick；
   * main bootstrap listener 桥接 eventBus.on('issue-changed') → safeSend(IpcEvent.IssueChanged)。
   *
   * **hardDeleted issue:null + 删前 snapshot sourceSessionId**：record 已不存在,但事件载体让
   * renderer 仍能精细 invalidate（与 TaskChanged.ownerSessionId 顶级字段对称 — §D7 R3 LOW F7）。
   */
  IssueChanged: 'event:issue-changed',
  /**
   * archive-failure-ux-upthrow-20260515 plan：caller archive 失败 UX 上抛通道。
   *
   * payload schema 与 event-bus.ts EventMap['caller-archive-failed'] 同(archive-toctou-fix-20260515
   * plan 已 narrow union):
   *   { sessionId: string; toolName: 'archive_plan' | 'hand_off_session' | 'SessionHandOffSpawn';
   *     reason: string; reasonKind: 'row-missing' | 'probe-throw' | 'archive-throw' }
   *
   * 触发：mcp baton-cleanup（archive_plan / hand_off_session）+ K3 SessionHandOffSpawn
   * 三处 archive caller 失败时；main bootstrap listener 桥接到此 IPC channel。
   *
   * 当前 MVP 仅 macOS 系统通知 + IPC 上抛；renderer 端 P2 enhancement 全局 toast 容器
   * + 重试按钮（reasonKind='archive-throw' / 'probe-throw' 显示重试 / 'row-missing' 仅告知）留后续 plan。
   */
  CallerArchiveFailed: 'event:caller-archive-failed',

  // ─────────── R3.E9 — Agent Deck universal team backend events ───────────
  /** team 增删改 / member 改：聚合数组 payload，16ms debounce + per-team 累加。 */
  AgentDeckTeamChanged: 'event:agent-deck-team-changed',
  /** message 入队 / 状态变迁：聚合数组 payload，16ms debounce + per-message 累加。 */
  AgentDeckMessageChanged: 'event:agent-deck-message-changed',
} as const;

export type IpcInvokeChannel = (typeof IpcInvoke)[keyof typeof IpcInvoke];
export type IpcEventChannel = (typeof IpcEvent)[keyof typeof IpcEvent];
