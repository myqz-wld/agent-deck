/**
 * 类型 — Claude SDK bridge（CHANGELOG_52 Step 3a / 第三轮大文件拆分）。
 *
 * 抽自 sdk-bridge.ts 顶部 interface 段。在 3g 完成「文件迁目录」前，
 * sdk-bridge.ts 仍 import 这些类型；class state 不动。
 */
import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@main/adapters/types';
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

/**
 * 队列元素：用 thunk 形式承载「构造 SDKUserMessage 的延迟操作」。
 *
 * 设计理由（HIGH-2 修法）：
 * - 纯文本消息：thunk 同步 resolve（`() => Promise.resolve(makeUserMessage(...))`），无开销
 * - 带 attachments 消息：thunk 内 `await fs.readFile(path)` + base64 + 构造 image content blocks
 *   保证：① 队列内存只存 path 不常驻 30MB×N base64
 *         ② SDK consume 完即 GC base64
 *         ③ FIFO 顺序保留（thunk 入队是同步的）
 * - consumer (createUserMessageStream) yield 前 `await thunk()`，期间 SDK Query 短暂阻塞
 *   等磁盘读（10MB ~10ms 级别）—— 可接受
 */
export type PendingUserMessage = () => Promise<SDKUserMessage>;

export interface InternalSession {
  /** 等待 SDK 真实 session_id 之前用的临时 id；拿到后会被替换 */
  realSessionId: string | null;
  cwd: string;
  query: Query;
  /**
   * 权限模式 in-memory cache（CHANGELOG_72 Bug 3 修法）。
   *
   * **存在意义**：canUseTool 判断 `bypassPermissions` 短路时，sessionRepo 不可靠 —
   * `await adapter.createSession()` 内部 SDK 已起 + stream 已开始消费 + canUseTool 已可触发，
   * 但应用层 `recordCreatedPermissionMode()` 在 createSession 返回后才调用（adapters.ts:159 → :176
   * 的时序铁证）。新建 bypassPermissions 会话首条 prompt 触发的工具调用就会撞上「sessionRepo
   * permission_mode 仍为 null（=默认）」窗口，让短路判断失效，弹 unwanted permission-request。
   *
   * 与 SDK options 同源：createSession 创建 internal 时设 `opts.permissionMode ?? 'default'`，
   * 与同一份 opts 传给 SDK `query({ options: { permissionMode, allowDangerouslySkipPermissions: ... } })` 一致。
   * setPermissionMode / restartWithPermissionMode 切档时同步更新（restart 走 closeSession + createSession
   * 自然带新值，setPermissionMode 显式 `s.permissionMode = mode`）。canUseTool 通过 deps.getPermissionMode 读。
   */
  permissionMode: PermissionMode;
  pendingUserMessages: PendingUserMessage[];
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

/**
 * Factory：构造空白 InternalSession（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 11 字段对象字面量，集中字段初值默认逻辑
 * （permissionMode 与 query options 同源 `opts.permissionMode ?? 'default'`，详
 * permissionMode 字段 jsdoc）。query 字段 spawn 之前用 `undefined as Query` 占位，
 * realSessionId 等首条 SDKMessage 拿到后 by waitForRealSessionId 替换。
 */
export function makeInternalSession(opts: {
  cwd: string;
  permissionMode?: PermissionMode;
}): InternalSession {
  return {
    realSessionId: null,
    cwd: opts.cwd,
    query: undefined as unknown as Query,
    permissionMode: opts.permissionMode ?? 'default',
    pendingUserMessages: [],
    notify: null,
    pendingPermissions: new Map(),
    pendingAskUserQuestions: new Map(),
    pendingExitPlanModes: new Map(),
    toolUseNames: new Map(),
  };
}
