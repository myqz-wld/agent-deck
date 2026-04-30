/**
 * 跨进程共享的核心类型。
 * 所有定义在这里的类型必须只依赖标准库 / TS 自带能力，不能引入 Electron / Node 特有 API。
 */

// ───────────────────────────────────────────────────────── AgentEvent

export type AgentEventKind =
  | 'session-start'
  | 'message'
  | 'thinking'
  | 'tool-use-start'
  | 'tool-use-end'
  | 'file-changed'
  | 'waiting-for-user'
  | 'finished'
  | 'session-end'
  | 'team-task-created'
  | 'team-task-completed'
  | 'team-teammate-idle';

export interface AgentEvent<P = unknown> {
  sessionId: string;
  agentId: string;
  kind: AgentEventKind;
  payload: P;
  ts: number;
  /**
   * 事件来源通道。同一 Claude Code 会话可能同时被 SDK 通道（query AsyncGenerator）
   * 和 Hook 通道（settings.json 注入的 hook）观测到，需要据此去重，
   * 否则会重复入库。SDK 通道粒度更细，因此一旦确认某 sessionId 由 SDK 接管，
   * 后续来自 hook 的同 id 事件会被 SessionManager 丢弃。
   */
  source?: 'sdk' | 'hook';
  /**
   * REVIEW_12 Bug 5：仅 hook 通道事件携带，标记该 CLI 子进程是否由本应用 SDK 派生。
   * - `'sdk'`：SDK spawn 出的 CLI 子进程（含其内部 fork 出的子会话），env 注入
   *   `AGENT_DECK_ORIGIN=sdk` → hook curl 转发 `X-Agent-Deck-Origin: sdk` header
   * - `'cli'`：完全独立的 CLI 进程（用户在终端跑 `claude`），无 env → header 走默认 'cli'
   * - `undefined`：老版本 hook 命令未携带（升级前 settings.json 里残留），按 'cli' 兼容
   *
   * 用途：ingest 入口识别「OLD CLI 被 SIGTERM 后飞回的迟到 hook event 用了新 sessionId
   * + cwd=home」这类孤儿 SDK-derived hook，避免误创建 source='cli' record
   * （典型 approve-bypass 冷切场景）。不依赖 sessionId / cwd 等会被 CLI 内部 fork 错乱的值。
   */
  hookOrigin?: 'sdk' | 'cli';
}

// ───────────────────────────────────────────────────────── Session

export type ActivityState = 'idle' | 'working' | 'waiting' | 'finished';
/**
 * 自动生命周期：active → dormant → closed（按 last_event_at 时间衰减，由 LifecycleScheduler 推进）。
 * 「归档」是与 lifecycle 正交的标记，由 SessionRecord.archivedAt 决定（非 null = 已归档）。
 * 这样取消归档可以保留归档前的真实生命周期，而不是粗暴回到某个固定值。
 */
export type LifecycleState = 'active' | 'dormant' | 'closed';
/**
 * SDK 通道的会话级权限模式。SDK Query 自己持有运行时真值但不暴露 getter，
 * 因此把「用户上次主动选过的值」持久化在 sessions.permission_mode 列里，
 * 切回 detail 或恢复会话时还原。
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
/**
 * 'sdk' = 应用内通过 ＋ 按钮新建的会话（可发消息、可响应权限请求）
 * 'cli' = 外部终端 `claude` 通过 hook 上报的会话（只读，UI 提示用户去终端操作）
 */
export type SessionSource = 'sdk' | 'cli';

export interface SessionRecord {
  id: string;
  agentId: string;
  cwd: string;
  title: string;
  source: SessionSource;
  lifecycle: LifecycleState;
  activity: ActivityState;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  archivedAt: number | null;
  /** SDK 通道：上次手动选过的权限模式；null/undefined 视为 'default'。CLI 通道字段无意义。 */
  permissionMode?: PermissionMode | null;
  /**
   * Agent Teams：会话所属团队名（仅 SDK 通道写）。null/undefined = 不在任何 team。
   * 与 settings.agentTeamsEnabled 联合作为「spawn 时注入 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1」
   * 的触发条件；team 元信息（成员 / shared task list）权威源是 ~/.claude/teams/<name>/ 与
   * ~/.claude/tasks/<name>/，不在 DB 复刻。CLI 通道字段无意义。
   */
  teamName?: string | null;
}

// ───────────────────────────────────────────────────────── Agent Teams (M2)

/**
 * Agent Teams 团队成员（来自 ~/.claude/teams/<name>/config.json 的 members 数组）。
 * Claude Code 自管这个文件，应用层只读不写。字段按官方文档约定，但**实验特性 schema
 * 可能演进**，所有字段除 name 外都标可选，解析失败兜底降级而不是报错。
 */
export interface TeamMember {
  /** 成员名（lead 在 config.json 里也以一个成员条目存在） */
  name: string;
  /** subagent 类型（如 "general-purpose" / "agent-deck:reviewer-claude"） */
  agentType?: string;
  /** Claude 内部分配的 agent id（不是应用层 sessionId） */
  agentId?: string;
  /** 仅 split-pane 模式下有：该 teammate 自己的 SDK session_id */
  sessionId?: string;
  /** 任意附加字段（schema 演进时不丢） */
  [key: string]: unknown;
}

/** ~/.claude/teams/<name>/config.json 解析结果。corrupt / 文件不存在 → readTeamConfig 返回 null。 */
export interface TeamConfig {
  members: TeamMember[];
  /** mtime（毫秒），renderer 显示「上次更新 X 分钟前」用 */
  mtime: number;
  /** 原始 JSON（解析失败时为 null）；UI 调试 / 「显示 raw config」入口用 */
  raw: Record<string, unknown> | null;
}

/**
 * 一个 team 的完整快照：聚合 SQL 里同 team_name 的 sessions + fs 里 ~/.claude/teams/<name>/config.json
 * 的成员清单 + ~/.claude/tasks/<name>/ 下的 shared task list markdown。
 * TeamHub / TeamDetail 一次性拉取这个对象渲染。
 */
export interface TeamSnapshot {
  name: string;
  /** 应用 DB sessions 表里 team_name = name 的会话（含 closed / archived） */
  sessions: SessionRecord[];
  /** ~/.claude/teams/<name>/config.json 解析结果；目录不存在或 JSON 损坏 → null */
  config: TeamConfig | null;
  /** ~/.claude/tasks/<name>/ 下的 shared task list 文件路径（绝对路径，UI 显示用） */
  taskListFile: string | null;
  /** task list markdown 文本；目录 / 文件不存在 → null */
  taskListMarkdown: string | null;
  /** task list 文件 mtime（毫秒）；用于 UI 显示「最后更新时间」+ chokidar 防抖判断 */
  taskListMtime: number | null;
  /**
   * Agent Teams M3：team 内所有 team-* event（最近 100 条），按 ts DESC。
   * 来自 hook-server 接 TaskCreated / TaskCompleted / TeammateIdle 写入 events 表，
   * JOIN sessions 表按 team_name 聚合。renderer TeamDetail 事件流 section 用。
   */
  events: AgentEvent[];
}

/**
 * TeamList IPC 返回的简表项（不含完整 sessions / task list 内容，仅元信息）。
 * TeamHub 列表用，避免 N 个 team 一次拉全量数据撑爆 IPC payload。
 */
export interface TeamSummary {
  name: string;
  /** 应用 DB 里 team_name = name 的 sessions 数量 */
  sessionCount: number;
  /** ~/.claude/teams/<name>/config.json 是否存在（即 Claude 已建队） */
  hasConfig: boolean;
  /** ~/.claude/tasks/<name>/ 是否存在且含至少 1 个 .md */
  hasTasks: boolean;
  /** sessions 表里同 team 最后一条 lastEventAt；无 session 则 null */
  lastEventAt: number | null;
}

/** TeamDataChanged IPC event payload：哪个 team 的哪个数据源变了，renderer 据此决定要不要重拉。 */
export interface TeamDataChangedEvent {
  name: string;
  /** 'config' = config.json 变了；'task-list' = tasks 目录下的 markdown 变了；'unlinked' = 整个 team 目录被删 */
  kind: 'config' | 'task-list' | 'unlinked';
}

/**
 * Agent Teams M3 hook event payload。Claude Code v2.1.32+ 实验特性 hook
 * （TaskCreated / TaskCompleted / TeammateIdle）转换后的 AgentEvent payload 形态。
 *
 * **字段全可选 + raw 备查**：实验特性 schema 仍在演进，hook payload 可能改字段名 / 结构；
 * translate 函数 best-effort 提取常见字段（`teamName` / `teammateName` / `task.*`），
 * 同时把原始 hook payload 全量塞进 raw，让 UI / debug 能看全。
 */
export interface TeamTaskPayload {
  cwd?: string;
  /** 来自 hook payload 的 team_name 字段（lead 所属 team） */
  teamName?: string;
  /** 来自 hook payload 的 teammate_name / agent_name（如果是某 teammate 创建/完成的 task） */
  teammateName?: string;
  /** 任务 id（如果 hook 给了；用于跨 created/completed 事件配对） */
  taskId?: string;
  /** 任务描述（hook 给的 description / title / content） */
  description?: string;
  /** 指派对象（如果 lead 显式分派） */
  assignee?: string;
  /** 依赖 task id 列表（hook 给了 depends_on / dependencies） */
  dependsOn?: string[];
  /** 状态（hook 给了 status / state，如 'pending' / 'in_progress' / 'done'） */
  status?: string;
  /** 完整原始 hook payload，UI 调试 / schema 演进时可全量看 */
  raw?: Record<string, unknown>;
}

export interface TeamTeammateIdlePayload {
  cwd?: string;
  /** 来自 hook payload 的 team_name */
  teamName?: string;
  /** 哪个 teammate idle 了 */
  teammateName?: string;
  /** 上次完成的 task 描述（如果 hook 给了） */
  lastTask?: string;
  /** idle 原因（如 'task-complete' / 'no-pending-tasks' / 'manual-shutdown'） */
  reason?: string;
  /** 完整原始 hook payload */
  raw?: Record<string, unknown>;
}

/**
 * SDK 通道的 canUseTool 回调把每次工具调用转化为一次权限请求，
 * 通过 `waiting-for-user` 事件 payload 推给前端，前端用 respondPermission(...)
 * 返回 allow / deny。
 */
export interface PermissionRequest {
  type: 'permission-request';
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** SDK 提供的「下次自动允许」建议（一般是 always-allow 的 PermissionUpdate） */
  suggestions?: unknown;
}

export interface PermissionResponse {
  decision: 'allow' | 'deny';
  /** allow 时可改写 input；deny 时作为给模型的 message */
  message?: string;
  updatedInput?: Record<string, unknown>;
  /** allow 时若用户选「always allow」，把 SDK 给的 suggestions 直接回传 */
  updatedPermissions?: unknown;
}

// ───────────────────────────────────────────────────────── Ask-User-Question

/**
 * Claude Code 的 AskUserQuestion 工具会在 SDK 通道里被 canUseTool 拦下来，
 * 走这条独立通路：UI 弹问题面板让用户点选项，回答通过 respondAskUserQuestion
 * 提交回主进程，主进程把答案塞进给 SDK 的 deny.message 里反馈给 Claude
 * （Claude 看到这条 tool_result 就知道用户的选择了）。
 */
export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserOption[];
}

export interface AskUserQuestionRequest {
  type: 'ask-user-question';
  requestId: string;
  toolUseId?: string;
  questions: AskUserQuestionItem[];
}

export interface AskUserQuestionAnswer {
  /** 每个 question 一项，按 questions 顺序对齐；multiSelect 时多个 label，单选时一个 */
  answers: { question: string; selected: string[]; other?: string }[];
}

// ───────────────────────────────────────────────────────── Exit-Plan-Mode

/**
 * Claude Code 的 ExitPlanMode 工具：在 plan mode 下 Claude 完成规划后，
 * 调用此工具向用户「提议执行此计划」。SDK 通道里跟 AskUserQuestion 一样
 * 走独立通路：UI 渲染 markdown plan + 「批准 / 继续规划」二选一按钮。
 *
 * 语义：
 * - 批准 → SDK canUseTool 返回 allow，Claude 工具调用成功 → 退出 plan mode 开始执行
 * - 继续规划 → SDK canUseTool 返回 deny + 用户反馈 message，Claude 留在 plan mode 修计划
 */
export interface ExitPlanModeRequest {
  type: 'exit-plan-mode';
  requestId: string;
  toolUseId?: string;
  /** plan 内容，通常是 markdown 文本（从 toolInput.plan 取） */
  plan: string;
}

/**
 * 批准 ExitPlanMode 时**必须**指定切到的目标权限模式。
 * - approve + targetMode ∈ {default, acceptEdits, plan}：热切，SDK Query.setPermissionMode 立即生效
 * - approve-bypass：冷切（独立 decision 避免误用热切路径），sdk-bridge 销毁旧 query +
 *   用 `allowDangerouslySkipPermissions: true` 重启子进程，复用 recoverAndSend 的 H4/H1 护栏，
 *   并把 plan 文本作为 handoff prompt 让 Claude 在 bypass 模式重新执行（避开 jsonl flush race）
 * - keep-planning：deny + 用户反馈，Claude 留在 plan mode 修计划
 */
export type ExitPlanModeResponse =
  | { decision: 'approve'; targetMode: 'default' | 'acceptEdits' | 'plan' }
  | { decision: 'approve-bypass' }
  | { decision: 'keep-planning'; feedback?: string };

// ───────────────────────────────────────────────────────── File Changes / Diff

export interface FileChangeRecord {
  id: number;
  sessionId: string;
  filePath: string;
  kind: string; // 'text' | 'image' | 'pdf' | ...
  beforeBlob: string | null;
  afterBlob: string | null;
  metadata: Record<string, unknown>;
  toolCallId: string | null;
  ts: number;
}

export interface DiffPayload<T = unknown> {
  kind: string;
  filePath: string;
  before: T | null;
  after: T | null;
  metadata?: Record<string, unknown>;
  toolCallId?: string;
  ts: number;
}

// ───────────────────────────────────────────────────────── Image Tools (MCP)

/**
 * 图片在事件流 / DiffPayload 里的承载形态。**不存图片二进制本身**，只存「怎么读到它」。
 * - kind:'path' 直接用绝对路径，主进程读盘后转 dataURL 给 renderer
 * - kind:'snapshot' 二期预留：让 MCP server 把快照交给 agent-deck 自管目录后用 id 索引
 * 之所以加这层抽象：MCP server 维护着自己的快照目录（ImageEdit 的 beforeFile 就放在那里），
 * 这些路径之后可能被 server 清理，DiffPayload 里只存「读取契约」让 renderer 兜底失效场景。
 */
export type ImageSource =
  | { kind: 'path'; path: string }
  | { kind: 'snapshot'; snapshotId: string };

/**
 * 本地 MCP server 暴露的图片工具的 tool_result 形态约定。
 * MCP server 在 `tool_result.content` 中放一个 `{type:'text', text: JSON.stringify(<下面这个>)}`，
 * agent-deck 解析后翻译成 file-changed 事件 + DiffPayload<ImageSource>（image-write/edit/multi-edit），
 * 或直接在活动流卡片里展示（image-read 不进 file-changed，UI 显示缩略图 + LLM 描述）。
 *
 * 工具语义（与 agent-deck-image-mcp 仓库一致）：
 * - ImageRead       = vision LLM 理解一张图，返回文字描述（不写盘）
 * - ImageWrite      = 文生图（prompt → 新图）写入 file_path
 * - ImageEdit       = 图生图（原图 + prompt → 新图）覆盖 file_path
 * - ImageMultiEdit  = 同一张图串行多次图生图（与文本 MultiEdit 对称）
 *
 * 路径要求：所有 file / beforeFile / afterFile 必须是**绝对路径**。
 * - file 是用户视角的真实文件路径（== input.file_path），工具完成后磁盘上的内容 == afterFile
 * - beforeFile / afterFile 是 server 自管快照目录里的副本（agent-deck 不复制不清理）
 *
 * ImageMultiEdit 语义（与文本 MultiEdit 完全对称）：
 * - 所有 edits 串行作用在「同一张图」（input 的 file_path）上
 * - 第 i 条 edit 的 beforeFile = 上一条的 afterFile（i=0 时 = 原图快照）
 * - agent-deck 把 N 条 edit 拆成 N 条独立的 file-changed 事件（filePath 都用 result.file），
 *   metadata 带 editIndex / total / prompt / provider / model，让 SessionDetail 时间线天然展示「演进步骤」
 */
export type ImageToolResult =
  | {
      kind: 'image-read';
      file: string;
      /** vision LLM 对这张图的描述（agent-deck 在活动流缩略图旁展示） */
      description: string;
      /** vision provider 名（'gemini' / 'openai' / ...），用于 UI 标注与调试 */
      provider?: string;
      model?: string;
      mime?: string;
      width?: number;
      height?: number;
    }
  | {
      kind: 'image-write';
      file: string;
      prompt: string;
      provider?: string;
      model?: string;
      mime?: string;
    }
  | {
      kind: 'image-edit';
      file: string;
      beforeFile: string;
      afterFile: string;
      prompt: string;
      provider?: string;
      model?: string;
      mime?: string;
    }
  | {
      kind: 'image-multi-edit';
      file: string;
      provider?: string;
      model?: string;
      edits: Array<{
        beforeFile: string;
        afterFile: string;
        prompt: string;
      }>;
    };

/**
 * window.api.loadImageBlob 的返回结构。
 * 失败不抛错，由 UI 显示「图片不可读」灰底（覆盖 server 清理快照后的兼容场景）。
 */
export type LoadImageBlobResult =
  | { ok: true; dataUrl: string; mime: string; bytes: number }
  | {
      ok: false;
      reason: 'enoent' | 'too_big' | 'denied' | 'invalid_ext' | 'io_error' | 'unsupported_source';
      detail?: string;
    };

// ───────────────────────────────────────────────────────── Summary

export interface SummaryRecord {
  id: number;
  sessionId: string;
  content: string;
  trigger: 'time' | 'event-count' | 'manual';
  ts: number;
}

// ───────────────────────────────────────────────────────── Settings

export interface AppSettings {
  hookServerPort: number;
  /**
   * HookServer Bearer 鉴权 token：本机任何进程都能 curl 127.0.0.1:port，
   * 没有 token 校验就能伪造 AgentEvent 污染 SQLite / 注入假会话。
   * 首次启动由 settings-store 自动生成 32 字节随机 hex 并持久化，
   * 后续保持稳定（让已安装的 hook 命令不会因 token 变动失效）。
   * 用户**不应**在 UI 上修改此值；仅在被泄漏需要轮换时手动清掉持久化文件让它重生成。
   */
  hookServerToken: string | null;
  enableSound: boolean;
  enableSystemNotification: boolean;
  silentWhenFocused: boolean;
  /** waiting 提示音文件绝对路径（mp3/wav/aiff/m4a）；null = 用 resources/sounds 默认或系统声音 */
  waitingSoundPath: string | null;
  /** finished 提示音文件绝对路径；null = 同上 */
  finishedSoundPath: string | null;
  activeWindowMs: number; // active → dormant 阈值
  closeAfterMs: number; // dormant → closed 阈值
  summaryIntervalMs: number; // 总结时间触发
  summaryEventCount: number; // 总结事件数触发
  summaryMaxConcurrent: number; // 同时跑 LLM 总结的会话上限
  /**
   * 单个 LLM oneshot 总结的超时阈值（毫秒）。0 = 永不超时。
   * SDK 一旦因代理超时 / 鉴权死锁 / API 限流卡在等 result，循环就永远不会退出，
   * inFlight 槽永不释放，maxConcurrent 个卡死后整个 Summarizer 不再产新总结。
   */
  summaryTimeoutMs: number;
  /** 权限请求未响应自动 abort 的阈值（毫秒）。0 = 不超时。 */
  permissionTimeoutMs: number;
  alwaysOnTop: boolean;
  /**
   * pin（始终置顶）时是否同步关闭系统 vibrancy（macOS 「under-window」毛玻璃）让 CSS 主导通透。
   * - true（默认，与历史行为一致）：pin 时去掉浅灰玻璃基底，肉眼能透到下层桌面 / 其它 app；
   *   配合 startInvalidateLoop + setBackgroundThrottling(false) 持续刷新下层像素。
   * - false：pin 时仍保留 'under-window' 实玻璃，看不到下层。
   * 改动即时生效（不需要重启 / 重建窗口）。
   */
  transparentWhenPinned: boolean;
  startOnLogin: boolean;
  /**
   * 历史会话自动清理保留天数（基于 lastEventAt）。
   * - 正数：超过该天数的「历史会话」（lifecycle = closed 或 archived_at IS NOT NULL）
   *   将被 LifecycleScheduler 在每次扫描时批量删除（事件 / 文件改动 / 总结一并 CASCADE）。
   * - 0：禁用自动清理（永远保留历史）。
   * 不影响 active / dormant：那些先由生命周期阈值推到 closed 后才进入清理候选。
   */
  historyRetentionDays: number;
  /**
   * Codex CLI 二进制绝对路径（@openai/codex-sdk 的 codexPathOverride）。
   * - null：用 SDK 自带的 vendored 二进制（@openai/codex 跟随 npm 装上，已打包进 .app）
   * - 绝对路径：覆盖为外部 codex（例如用户自装的更新版 `which codex` 给的路径）
   * agent-deck 不读不写 codex 鉴权（`~/.codex/config.toml` / 环境变量），全由用户终端配置。
   */
  codexCliPath: string | null;
  /**
   * 是否把 agent-deck 自带的 CLAUDE.md（`resources/claude-config/CLAUDE.md` 或用户副本
   * `userData/agent-deck-claude.md`）注入到 SDK 会话 system prompt 末尾。
   * - true（默认）：注入，让会话遵循 agent-deck 项目内通用约定
   * - false：不注入，会话只受 user/project/local CLAUDE.md 控制
   *
   * 改这个开关只影响**下次新建**的会话；已运行的 SDK 会话已经把 system prompt
   * 固化进 LLM 上下文，关掉不会回收。
   */
  injectAgentDeckClaudeMd: boolean;
  /**
   * 是否把 agent-deck 自带的 plugin（`resources/claude-config/agent-deck-plugin/`）
   * 注入到 SDK 会话。**plugin 整体注入或整体不注入**——一个 toggle 同时控制两类内容：
   *
   * - **skills**：以 `agent-deck:<skill-name>` 命名空间注册（如 `agent-deck:deep-code-review`，
   *   多轮异构 review × fix 收口工作流）
   * - **agents**：以 `agent-deck:<agent-name>` 命名空间注册（如 `agent-deck:reviewer-claude`、
   *   `agent-deck:reviewer-codex`，异构对抗 reviewer subagent）
   *
   * SDK plugin 协议自动扫描 `<plugin>/skills/` 与 `<plugin>/agents/` 子目录，应用层只传
   * plugin path 即可。与用户 `~/.claude/skills/` + `~/.claude/agents/` + project
   * `.claude/skills/` + `.claude/agents/` 都不冲突（plugin 强制命名空间前缀）。
   *
   * 改这个开关只影响**下次新建**的会话；已运行的 SDK 会话已经在启动时拿到 plugin 列表，
   * 关掉不会撤销。
   */
  injectAgentDeckPlugin: boolean;
  /**
   * Agent Teams 实验特性总开关（默认 OFF）。开启后 NewSessionDialog 暴露 teamName 输入框；
   * 用户填了 teamName 的 SDK 会话在 spawn 时注入 env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，
   * 让 Claude 内部启用 agent teams（lead spawn teammates、共享 task list、3 个新 hook 事件）。
   *
   * 兼容性：需 Claude Code CLI ≥ v2.1.32（应用启动时 `claude --version` 自检；< 2.1.32
   * 自动跳过 hook 注入并在 SettingsDialog 显示版本不足提示）。Opus 4.6+ 推荐。
   *
   * 已知限制（Anthropic 官方）：no `/resume` 与 `/rewind`；no nested teams；one team per
   * session；lead 终身固定。**关闭开关只影响下次新建会话**——CLI 子进程已按 team 模式启动，
   * env 是 spawn 时一次性传入，不会被撤销。
   */
  agentTeamsEnabled: boolean;
  /**
   * Claude Code SDK 子进程的 OS 级沙盒档位（默认 'off'）。SDK 0.2.118 内置 sandbox 能力
   * （macOS Seatbelt / Linux bubblewrap），让用户在 UI 主动开启文件系统 + 网络 OS 级隔离。
   *
   * 三档语义：
   * - `'off'`：不启用沙盒，行为同现状（仅应用层 canUseTool 弹框决策）
   * - `'workspace-write'`：cwd 可写、用户敏感目录（~/.ssh / ~/.aws / ~/.config）只读、
   *   网络默认 deny；保留 `dangerouslyDisableSandbox` 逃逸路径（model fallback 时弹给用户审批）
   * - `'strict'`：cwd 只读、网络默认 deny + `failIfUnavailable: true`（沙盒不可用直接报错退出）
   *   + `allowUnsandboxedCommands: false`（封死 dangerouslyDisableSandbox 逃逸）
   *
   * 与 codex-cli 已默认的 `sandboxMode: 'workspace-write'` 对齐策略：默认 off 让用户主动开
   * （REVIEW_14 推荐路径阶段 2），观察 1-2 周用户反馈无异常后阶段 3 再考虑切默认 on。
   *
   * **关闭开关只影响下次新建会话**——已在跑的 SDK 子进程已按当前档位 spawn，sandbox 是
   * spawn-time options，不会被撤销（与 agentTeamsEnabled 同模式）。
   *
   * **summarizer 不被污染**：summarizer 走 `settingSources: []` + 自己 query() 调用，
   * 不读 sandbox 设置（与 agentTeamsEnabled 隔离同模式）。
   */
  claudeCodeSandbox: 'off' | 'workspace-write' | 'strict';
}

export const DEFAULT_SETTINGS: AppSettings = {
  hookServerPort: 47821,
  hookServerToken: null,
  enableSound: true,
  enableSystemNotification: true,
  silentWhenFocused: true,
  waitingSoundPath: null,
  finishedSoundPath: null,
  activeWindowMs: 30 * 60 * 1000,
  closeAfterMs: 24 * 60 * 60 * 1000,
  summaryIntervalMs: 5 * 60 * 1000,
  summaryEventCount: 10,
  summaryMaxConcurrent: 2,
  summaryTimeoutMs: 60 * 1000,
  permissionTimeoutMs: 5 * 60 * 1000,
  alwaysOnTop: true,
  transparentWhenPinned: true,
  startOnLogin: false,
  historyRetentionDays: 30,
  codexCliPath: null,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckPlugin: true,
  agentTeamsEnabled: false,
  claudeCodeSandbox: 'off',
};

// ───────────────────────────────────────────────────────── Hook Status

export interface HookInstallStatus {
  installed: boolean;
  scope: 'user' | 'project' | null;
  settingsPath: string | null;
  installedHooks: string[];
}

// ───────────────────────────────────────────────────────── Permission Settings Scan

/**
 * Claude Code 的 settings 四层来源（与 SDK 实际读取行为对齐）。
 * 优先级低 → 高（高覆盖低）：
 * - user:       ~/.claude/settings.json
 * - user-local: ~/.claude/settings.local.json   ← 官方文档未明示，但 SDK / CLI 实际会读
 * - project:    <cwd>/.claude/settings.json
 * - local:      <cwd>/.claude/settings.local.json
 */
export type SettingsSource = 'user' | 'user-local' | 'project' | 'local';

/** 每层 settings.json 解析出的 permissions 字段（按 SDK schema 抽取，未知字段忽略）。 */
export interface SettingsPermissionsBlock {
  allow: string[];
  deny: string[];
  ask: string[];
  additionalDirectories: string[];
  defaultMode: string | null;
}

/** 单层 settings 文件的扫描结果。文件不存在也会返回（exists=false + raw=null）。 */
export interface SettingsLayer {
  source: SettingsSource;
  /** 推断出的绝对路径，无论是否存在 */
  path: string;
  exists: boolean;
  /** 原文（pretty-print 后），文件不存在为 null */
  raw: string | null;
  /** JSON.parse 结果，解析失败 / 文件不存在为 null */
  parsed: unknown | null;
  /** 解析失败时记错误消息 */
  parseError: string | null;
  /** 提取出的 permissions 块；不存在 / 解析失败时为 null */
  permissions: SettingsPermissionsBlock | null;
}

/** 合并视图：去重后每条规则带来源层标签。 */
export interface MergedRule {
  rule: string;
  sources: SettingsSource[];
}

export interface MergedDirectory {
  dir: string;
  sources: SettingsSource[];
}

export interface MergedPermissions {
  allow: MergedRule[];
  deny: MergedRule[];
  ask: MergedRule[];
  additionalDirectories: MergedDirectory[];
  /** 倒序找第一个非 null：local > project > user-local > user */
  defaultMode: { value: string; source: SettingsSource } | null;
}

export interface PermissionScanResult {
  /** 入参 cwd 原值（trim 后；为空时 main 进程会替换成 homedir，并在 cwdResolved 标记） */
  cwd: string;
  /** 实际用于解析 project / local 的 cwd（兜底为 homedir） */
  cwdResolved: string;
  user: SettingsLayer;
  /** ~/.claude/settings.local.json，user 级个人覆盖 */
  userLocal: SettingsLayer;
  project: SettingsLayer;
  local: SettingsLayer;
  merged: MergedPermissions;
}
