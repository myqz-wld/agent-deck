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
  answers: { question: string; selected: string[]; other?: string; note?: string }[];
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
  /**
   * Omitted/adapter = native Claude ExitPlanMode. mcp = Agent Deck MCP
   * present_plan, which reuses the same UI but does not change SDK
   * permission mode when approved.
   */
  reviewSource?: 'adapter' | 'mcp';
  title?: string;
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

/** Renderer-visible identity of the isolated native fork used for MCP plan review. */
export interface PlanDeepReviewSession {
  sessionId: string;
  agentId: 'claude-code' | 'deepseek-claude-code' | 'codex-cli';
}

/** Editable soft refusal used when no review dialogue exists and no LLM should be started. */
export const NO_PLAN_REVIEW_DIALOGUE_FEEDBACK = '尚未进行审阅对话，暂无修改意见。';

// ───────────────────────────────────────────────────────── Diff Review

export type DiffReviewMode = 'pr' | 'merge-conflict';

export interface DiffReviewPrFragment {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  unifiedDiff?: string;
}

export interface DiffReviewConflictFragment {
  ours: string;
  theirs: string;
  resolution: string;
  base?: string;
  oursLabel?: string;
  theirsLabel?: string;
  resolutionLabel?: string;
  baseLabel?: string;
}

export type DiffReviewAnnotationPane =
  | 'before'
  | 'after'
  | 'both'
  | 'base'
  | 'ours'
  | 'theirs'
  | 'resolution';

export interface DiffReviewAnnotation {
  pane: DiffReviewAnnotationPane;
  /** 1-based line number; 0 means before the first displayed line. */
  line?: number;
  title?: string;
  body: string;
}

export interface DiffReviewRequest {
  type: 'diff-review';
  requestId: string;
  mode: DiffReviewMode;
  title?: string;
  filePath?: string;
  language?: string;
  instructions?: string;
  /** Explanation shown to the user before they approve or request changes. */
  rationale: string;
  annotations?: DiffReviewAnnotation[];
  pr?: DiffReviewPrFragment;
  conflict?: DiffReviewConflictFragment;
}

export type DiffReviewResponse =
  | { decision: 'approve' }
  | { decision: 'revise'; feedback?: string };

// ───────────────────────────────────────────────────────── Team Permission Request

/**
 * R3.E6 (PR-B) — 老 inbox 协议 TeamPermissionRequest / TeamPermissionCancelled /
 * TeamPermissionDecision 全部删除。
 *
 * 老语义：CHANGELOG_45 老 inbox 协议把 teammate 调工具的 permission_request 通过文件协议
 * 转发给 lead；硬切后 universal team backend 不再接管这条路径，CLI 内自起的 team 在
 * agent-deck UI 完全失明（详 docs/agent-deck-team-protocol.md §10.1）。
 *
 * 本注释段保留只是为了让 grep 能找到「为什么没了」的原因；类型本身已删。
 */
