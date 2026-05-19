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
   * tool_use_id → file-changed payload(不含 sessionId/agentId/kind/ts) 映射。
   *
   * **plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.5 修法**(A1-MED-1 codex):
   * Edit / Write / MultiEdit 的 file-changed emit 时序从 assistant.tool_use(SDK 上行 tool_use
   * 帧) 推迟到 user.tool_result + status='completed'。修前:tool_use 阶段就 emit file-changed,
   * 但 SDK 工具调用可能 fail(典型 Edit old_string mismatch / Write 写入 perm denied / MultiEdit
   * 中间一条 mismatch),tool_result 回 is_error=true 仍 emit 了脏 file-changed 进 DB +
   * SessionDetail 时间线 + 用户看到「编辑了文件」错觉但 fs 上没改。
   *
   * 修法:tool_use 阶段把 intent push 到本 Map(pushFileChangeIntent),tool_result 阶段拿
   * tool_use_id find → status='completed' emit + delete / status='failed' 仅 delete 不 emit。
   * session-end / consume finally 时显式 clear 防 leak(虽然 internal GC 会带走,显式 clear
   * 与 toolUseNames 同款保险)。图片工具路径走 maybeEmitImageFileChanged 另一路径,本 Map
   * 不参与图片工具(图片工具已经是 tool_result 阶段 emit,无 fail 路径污染问题)。
   */
  pendingFileChangeIntents: Map<string, Record<string, unknown>>;
  /**
   * 应用层主动关闭/重启该 session 的标记。置位时 query loop catch 块抛的 SDK 错误
   * （典型：approve-bypass deny+interrupt:true 触发 SDK 内部 [ede_diagnostic] 状态机
   * 不一致诊断错误）属于设计内副产品，UI 不再 emit 红字，仅 console.warn 留痕。
   * 在 closeSession（含 restartWithPermissionMode 走的冷切路径）/ approve-bypass resolver
   * 之前置位；不需要清，因为 internal session 紧接着会被 sessions Map 删除。
   */
  expectedClose?: boolean;
  /**
   * **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.1+2.5 修法**（H1+H2 race 双保险
   * (A) abort consume）：fallback fire / createSession throw 双路径 fire-and-forget interrupt 的
   * idempotency guard。
   *
   * **作用范围严格限定**（R3 plan-review codex LOW-1 + claude INFO 收窄文案）：
   * - stream-processor.ts setTimeout fallback fire 路径（Phase 2.1）
   * - index.ts createSession throw catch 块（Phase 2.5）
   *
   * **不覆盖**：public `interrupt(sessionId)` (index.ts:487-491) + `closeSession(sessionId)`
   * (index.ts:522-527) 入口仍独立 await SDK interrupt **不读** 此 flag（设计内 — caller 显式
   * 调用应当直通 SDK，与 spike1 实证 interrupt() 幂等 SDK 行为一致）。
   *
   * 防 caller 也手动 interrupt 与 fallback/throw 路径并发触发 N round-trip：双路径都先查
   * `if (!internal.interruptFired) { internal.interruptFired = true; void internal.query?.interrupt?.(); }`。
   * flag 不需清（与 expectedClose 同款 — internal session 紧接着会被 sessions Map 删除 + GC）。
   */
  interruptFired?: boolean;
  /**
   * **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.7 修法**（R3 plan-review codex MED-2
   * + R2 plan-review MED-F + R4 plan-review codex MED-1 强制 per-session seq）：setPermissionMode
   * 无锁 async 并发回滚 race 防御计数器。
   *
   * **race 真根因**：旧 impl 单 try/catch 同步赋值 + catch 回滚 oldMode。同 session same-mode 并发
   * 撞 race：A 设 plan await SDK 失败 + B 设 plan await SDK 成功 → A SDK throw catch 当前 mode=plan
   * 按「当前值 guard」错误回滚成 default 把 B 已成功 plan 改回去（B 实际 SDK 已切到 plan，应用
   * cache 却被 A catch 错误降回 default → cache vs SDK 不同步）。
   *
   * **修法 = per-session seq counter**：setPermissionMode 入口 ++seq；catch 内仅当 `s.permissionModeSeq ===
   * seq`（无后续 setPermissionMode 推进 seq）时回滚。同 session 多次切档只看 seq 是否被推进过决定
   * 是否回滚，与「当前值 guard」无关。
   *
   * **不能用 bridge 全局 seq**（R2 plan-review MED-F）：会被跨 session 干扰（A session 设 plan +
   * B session 设 default 并发 → A throw 时全局 seq 已被 B 推进 → A 错误判定 seq 推进 → 不回滚）。
   *
   * 默认 0；makeInternalSession factory 初始化为 0；不需清。
   */
  permissionModeSeq: number;
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
    pendingFileChangeIntents: new Map(),
    // Phase 2.7 修法：per-session seq counter 默认 0（详 InternalSession.permissionModeSeq jsdoc）
    permissionModeSeq: 0,
  };
}
