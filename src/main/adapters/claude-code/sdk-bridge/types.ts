/**
 * 类型 — Claude SDK bridge（CHANGELOG_52 Step 3a / 第三轮大文件拆分）。
 *
 * 抽自 sdk-bridge.ts 顶部 interface 段。在 3g 完成「文件迁目录」前，
 * sdk-bridge.ts 仍 import 这些类型；class state 不动。
 */
import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
} from '@shared/types';

export interface SdkSessionHandle {
  sessionId: string;
  abort: () => void;
}

export interface SdkBridgeOptions {
  emit: (e: AgentEvent) => void;
  /** 权限请求未响应自动 abort 的阈值（毫秒）。0 = 不超时。运行时可通过 setPermissionTimeoutMs 改。 */
  permissionTimeoutMs?: number;
}

export interface PendingPermissionEntry {
  payload: PermissionRequest;
  resolver: (r: PermissionResult) => void;
  timer: NodeJS.Timeout | null;
}

export interface PendingAskQuestionEntry {
  payload: AskUserQuestionRequest;
  resolver: (a: AskUserQuestionAnswer) => void;
  timer: NodeJS.Timeout | null;
}

export interface PendingExitPlanModeEntry {
  payload: ExitPlanModeRequest;
  /** 真正驱动 SDK 行为的 resolver：approve → allow，keep-planning → deny+message */
  resolver: (response: ExitPlanModeResponse) => void;
  /** 拿到原始 input 用于 allow 时回填 updatedInput（保留 plan 字段不变） */
  toolInput: Record<string, unknown>;
  timer: NodeJS.Timeout | null;
}

export interface InternalSession {
  /** 等待 SDK 真实 session_id 之前用的临时 id；拿到后会被替换 */
  realSessionId: string | null;
  cwd: string;
  query: Query;
  pendingUserMessages: SDKUserMessage[];
  notify: (() => void) | null;
  /** 等待用户回应的权限请求：requestId → entry（payload + resolver + 超时定时器） */
  pendingPermissions: Map<string, PendingPermissionEntry>;
  /** 等待用户回答的 AskUserQuestion：requestId → entry */
  pendingAskUserQuestions: Map<string, PendingAskQuestionEntry>;
  /** 等待用户批准/继续规划的 ExitPlanMode：requestId → entry */
  pendingExitPlanModes: Map<string, PendingExitPlanModeEntry>;
  /**
   * tool_use_id → tool_name 映射。SDK 的 tool_result block 只带 tool_use_id 不带 toolName，
   * 但我们需要在 tool_result 时识别「这条结果是不是 mcp 图片工具的」才能翻译成 file-changed。
   * assistant.tool_use 处理时 set，user.tool_result 消费后 delete。
   */
  toolUseNames: Map<string, string>;
  /**
   * 应用层主动关闭/重启该 session 的标记。置位时 query loop catch 块抛的 SDK 错误
   * （典型：approve-bypass deny+interrupt:true 触发 SDK 内部 [ede_diagnostic] 状态机
   * 不一致诊断错误）属于设计内副产品，UI 不再 emit 红字，仅 console.warn 留痕。
   * 在 closeSession（含 restartWithPermissionMode 走的冷切路径）/ approve-bypass resolver
   * 之前置位；不需要清，因为 internal session 紧接着会被 sessions Map 删除。
   */
  expectedClose?: boolean;
}
