/**
 * 跨进程共享：权限请求 / Ask-User-Question / Exit-Plan-Mode / Team Permission 类型。
 */

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
 * Claude Code 的 ExitPlanMode 工具：在 plan mode 下 Claude 完成规划后,
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

// ───────────────────────────────────────────────────────── Team Permission Request

/**
 * Agent Teams in-process backend 的权限审批协议（CLI v2.1.32+ 实测）：
 *
 * teammate 调 Bash / Edit 等需审批工具时，CLI **不会**回到 lead 的 SDK canUseTool 回调
 * （那个是绑在 lead Query 实例上的）。CLI 改为把 `permission_request` JSON 文本塞进
 * lead 的 inbox 文件 `~/.claude/teams/<team>/inboxes/team-lead.json`，等待 lead 写
 * `permission_response` 文本回 teammate inbox。
 *
 * 应用做的事（inbox-watcher.ts）：
 * 1. 监听 `~/.claude/teams/<name>/inboxes/*.json`
 * 2. 解析每条消息的 text 字段为 JSON，识别出 type='permission_request' 的条目
 * 3. 把 request_id 没见过的 → emit AgentEvent waiting-for-user，payload 为本类型
 * 4. UI（PendingTab / TeamDetail）展示 + 用户 approve/deny → 写 permission_response
 *    回 teammate（fromMemberSlug）的 inbox 文件，teammate 收到后继续跑
 */
export interface TeamPermissionRequest {
  type: 'team-permission-request';
  /** 来自 inbox payload 的 request_id（同 SDK CLI 二进制 ge6() 函数） */
  requestId: string;
  /** 哪个 team（路径派生：~/.claude/teams/<teamName>/） */
  teamName: string;
  /** 哪个 teammate 提的（agent_id 字段，例如 "reviewer-codex"） */
  fromAgentId: string;
  /** 算好的 inbox 文件名 slug（agent_id 经 `/[^a-zA-Z0-9_-]/g→'-'`），用于回写 permission_response */
  fromMemberSlug: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** SDK CLI 给的可读描述（"Run shell command"、"Edit file" 等） */
  description?: string;
  /** 「下次自动允许」建议（与 PermissionRequest.suggestions 同语义） */
  permissionSuggestions?: unknown;
  /** 调试用：完整 inbox 文件路径，便于报错时人工排查 */
  inboxFilePath: string;
  /** 收到 inbox 消息的时间戳（ISO） */
  timestamp: string;
}

export type TeamPermissionDecision = 'allow' | 'deny';

/**
 * Inbox Watcher：teammate 自己 abort 了之前提的 permission_request（典型：lead 用
 * SendMessage 给 teammate 发 advice → teammate 主动 abort 当前 tool call → 不再等
 * permission 响应；或 teammate idle / shutdown）。inbox-watcher 检测到 teammate
 * 写 idle_notification 时把该 teammate 名下所有 active permission emit cancelled。
 *
 * 与 PermissionCancelled / AskQuestionCancelled / ExitPlanCancelled 同模式：
 * 1. UI 端从 pendingTeamPermissions 列表里删该 requestId（按钮不再可点）
 * 2. 历史 events 流里这条 cancelled event 留作活动条标灰显示「已被取消」
 */
export interface TeamPermissionCancelled {
  type: 'team-permission-cancelled';
  requestId: string;
  teamName: string;
  /** 哪个 teammate 的 abort（与原 TeamPermissionRequest.fromAgentId 对应） */
  fromAgentId: string;
  /** 取消原因（idle / shutdown / unknown），仅用于 log + UI 调试提示 */
  reason: 'teammate-idle' | 'teammate-shutdown' | 'unknown';
}
