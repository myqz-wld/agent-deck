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
  /** Codex 专属冷切（CHANGELOG_<X> A2b）：销毁旧 thread + 用新 sandbox 档位 resume 重建。 */
  AdapterRestartWithCodexSandbox: 'adapter:restart-with-codex-sandbox',
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
  /**
   * 加载用户在输入框上传的图片（与 ImageLoadBlob 走完全独立白名单）。
   * 路径必须在 <userData>/image-uploads/ 下；realpath + sep 严格前缀 + ext + size + 单 fd open/stat/readFile。
   * 失败不抛错，返回 { ok:false, reason }，UI 用灰底兜底（图片可能已被 reaper 清 / 用户磁盘删了）。
   */
  UploadedImageLoad: 'image:load-uploaded',
  /** 读取注入到 SDK system prompt 末尾的 agent-deck CLAUDE.md（用户副本优先 → 回落内置）。 */
  ClaudeMdGet: 'claude-md:get',
  /** 保存用户副本 CLAUDE.md 到 userData 目录，并清主进程注入缓存（下次新建会话生效）。 */
  ClaudeMdSave: 'claude-md:save',
  /** 删除用户副本 CLAUDE.md（如果存在），回落到内置版本，并清缓存。 */
  ClaudeMdReset: 'claude-md:reset',
  /**
   * 拉取 summarizer 最近一次失败原因（by sessionId）。UI 展示在设置面板「间歇总结」section，
   * 让用户能诊断「为什么这个会话没总结」（CHANGELOG_20 / G）。失败被吞到 console.warn 不够，
   * 用户没法用、运维也看不到。
   */
  SummarizerLastErrors: 'summarizer:last-errors',
  // ─────────── Agent Teams (M2) ───────────
  /** 列出所有 team 简表（合 SQL distinctTeamNames + fs ~/.claude/teams/）。TeamHub 列表用。 */
  TeamList: 'team:list',
  /** 拉一个 team 的完整 snapshot（sessions + config.json + 当前 task list 文件内容）。 */
  TeamGet: 'team:get',
  /** 订阅某 team 的 fs 变化（chokidar watch 引用计数 +1）。 */
  TeamSubscribe: 'team:subscribe',
  /** 取消订阅某 team（引用计数 -1，到 0 + 60s grace 后 close watcher）。 */
  TeamUnsubscribe: 'team:unsubscribe',
  /** Agent Teams M3：手动清理一个 team 的 fs 残留（rm -rf 两个目录）。
   *  典型用途：Claude in-process cleanup 上游 bug 卡住时让用户兜底。 */
  TeamForceCleanup: 'team:force-cleanup',
  /** Inbox watcher：订阅某 team 的 inbox 文件 fs 监听（chokidar 引用计数 +1）。
   *  TeamDetail mount 时调；自动订阅由 main 在 session-upserted 时同步，UI 订阅是补强。 */
  TeamSubscribeInbox: 'team:subscribe-inbox',
  /** 取消订阅某 team 的 inbox（引用计数 -1，到 0 + grace 后 close）。 */
  TeamUnsubscribeInbox: 'team:unsubscribe-inbox',
  /** 响应一条 teammate 的 permission_request：写 permission_response 文本到 teammate inbox。
   *  args: (teamName, fromMemberSlug, requestId, decision, updatedInput?)。 */
  TeamRespondPermission: 'team:respond-permission',
  /** 重建当前所有 team 的 pending team-permission-request 列表（HMR / 重启后）。 */
  TeamListPendingPermissions: 'team:list-pending-permissions',
  /** Task Manager (CHANGELOG_43)：拉指定 team 的 SQLite tasks 表（限 200 条）。
   *  TeamDetail「结构化 tasks (mcp)」section 用，订阅 IpcEvent.TaskChanged 后重拉。 */
  TaskListByTeam: 'task:list-by-team',

  // ─────────── Assets Library (CHANGELOG_57) ───────────
  /** 列出 agent-deck plugin 内置 agents+skills（main 启动时一次性扫 frontmatter，缓存读）。 */
  AssetsListBundled: 'assets:list-bundled',
  /** 列出用户自定义 ~/.claude/{agents,skills}/ 下全部资产。每次调用现扫现读。 */
  AssetsListUser: 'assets:list-user',
  /** 读单个 asset 完整 md 文本（含 frontmatter + body）。args: (kind, name, source)。 */
  AssetsGetContent: 'assets:get-content',
  /** 保存用户 asset：main 拼装 frontmatter + 原子写到 ~/.claude/<kind>/。args: UserAssetInput。 */
  AssetsSaveUser: 'assets:save-user',
  /** 删除用户 asset。args: (kind, name)。skill 是子目录递归 rm，agent 是单文件 unlink。 */
  AssetsDeleteUser: 'assets:delete-user',
  /** 在 Finder / 资源管理器中显示对应文件。args: (kind, name, source)。 */
  AssetsRevealInFolder: 'assets:reveal',
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
  /** Agent Teams M2：team 的 fs 数据变了（config.json / task list / 整个目录被 unlink）。
   *  payload: TeamDataChangedEvent。renderer 决定是否重拉对应 team 的 snapshot。 */
  TeamDataChanged: 'event:team-data-changed',
  /** Task Manager (CHANGELOG_43)：tasks 表写操作（create/update/delete）after-commit 推送。
   *  payload: TaskChangedEvent。当前 renderer 没 task UI 消费，未来加 Tasks tab 直接订阅。 */
  TaskChanged: 'event:task-changed',
  /** Inbox watcher：teammate 提的 permission_request 被识别后推一条 AgentEvent 给 renderer，
   *  payload 是 TeamPermissionRequest（外加 sessionId 用 lead session id 占位）。
   *  也兼复用 IpcEvent.AgentEvent 通路推送，本通道独立给「全 team 视角」UI 订阅用。 */
  TeamPermissionRequested: 'event:team-permission-requested',
  /** 用户在 UI 完成响应（或 inbox 被外部清掉）时通知 renderer：把 pending 列表里的这条删掉。 */
  TeamPermissionResolved: 'event:team-permission-resolved',
} as const;

export type IpcInvokeChannel = (typeof IpcInvoke)[keyof typeof IpcInvoke];
export type IpcEventChannel = (typeof IpcEvent)[keyof typeof IpcEvent];
