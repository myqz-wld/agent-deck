/**
 * 跨进程共享的核心类型。
 * 所有定义在这里的类型必须只依赖标准库 / TS 自带能力，不能引入 Electron / Node 特有 API。
 */

// ───────────────────────────────────────────────────────── AgentEvent

export type AgentEventKind =
  | 'session-start'
  | 'message'
  | 'tool-use-start'
  | 'tool-use-end'
  | 'file-changed'
  | 'waiting-for-user'
  | 'finished'
  | 'session-end';

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
}

// ───────────────────────────────────────────────────────── Permission Request

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

export interface ExitPlanModeResponse {
  decision: 'approve' | 'keep-planning';
  /** decision='keep-planning' 时可选用户反馈，会拼进给 Claude 的 deny.message */
  feedback?: string;
}

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
  startOnLogin: boolean;
  /**
   * 历史会话自动清理保留天数（基于 lastEventAt）。
   * - 正数：超过该天数的「历史会话」（lifecycle = closed 或 archived_at IS NOT NULL）
   *   将被 LifecycleScheduler 在每次扫描时批量删除（事件 / 文件改动 / 总结一并 CASCADE）。
   * - 0：禁用自动清理（永远保留历史）。
   * 不影响 active / dormant：那些先由生命周期阈值推到 closed 后才进入清理候选。
   */
  historyRetentionDays: number;
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
  startOnLogin: false,
  historyRetentionDays: 30,
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
