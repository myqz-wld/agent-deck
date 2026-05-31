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
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S2 / 不变量 1+2 双轨字段**:
   *
   * applicationSid 生命周期分两类(R3 HIGH-F + R7 HIGH-R7-1 修订双阶段化):
   *
   * 【spawn 主路径】(无 opts.resume 起新 SDK thread,resumeMode='resume-cli' default):
   * - ctor 时 applicationSid = tempKey (randomUUID() 临时占位)
   * - first realId 到达时 (stream-processor.ts:271 isNewSpawn 分支保护):
   *   - 调 sessionManager.renameSdkSession(tempKey, realId) 迁 DB row + 子表 (D2 spawn bootstrap rename 保留)
   *   - internal.applicationSid = realId (切到 first realId,从此冻结)
   *   - emit session-renamed{from: tempKey, to: realId} (D6 契约)
   * - first realId 之后任何 6 处反向 rename 都**不动** applicationSid
   *
   * 【resume / jsonl-missing fallback / restart-controller 路径】(已有会话):
   * - ctor 时 applicationSid = caller 传入 opts.resume (= sessions.id 应用稳定身份)
   * - 全生命周期 applicationSid 不变 (6 处反向 rename 仅改 cliSessionId 列)
   *
   * 用途 (S3-S5/S4b/S7/S9):
   * - sessions Map key 用 applicationSid (S3)
   * - event sid 派发用 applicationSid (S4 + S4b mcp-server-init / canUseTool / createUserMessageStream / pending-cancellation)
   * - createSession return handle.sessionId 用 applicationSid (S5)
   * - MCP token allocate 用 applicationSid (S7)
   * - finalizeSessionStart 入参用 applicationSid + cliSessionId (S9)
   */
  applicationSid: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S2**:
   * SDK / CLI 当前 thread sid (与 v021 sessions.cli_session_id 列对齐,允许 6 处反向 rename 路径变化)。
   *
   * 用途 (SDK / CLI 入参侧):
   * - SDK options.resume + jsonl preflight + S6 fork detect compare 用 effectiveResumeCliSid
   *   (S1 R6 升级:caller 传 opts.resumeCliSid 优先 / 不传时 bridge 内部反查 sessionRepo.cliSessionId 兜底回填)
   * - jsonl 路径命名 `~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl` (spike1 §1.2 实证)
   *
   * **null 边角** (D4 cli_session_id 列允许 NULL):
   * - spawn tempKey 阶段:SDK 还没给 first realId,cliSessionId 为 null
   * - jsonl-missing fallback 起 fresh CLI 期间 (resumeMode='fresh-cli-reuse-app'):cliSessionId 暂时 null,
   *   first realId 后通过 sessionManager.updateCliSessionId 写入 (R5 HIGH-R5-1 + R6 MED-R6-1 黑名单链)
   *
   * **R7 HIGH-R7-1 修订**: rename `realSessionId` → `cliSessionId` 字面切到 SDK 维度,
   * 与 SessionRecord.cliSessionId 字段对称。
   */
  cliSessionId: string | null;
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
   * **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase R3 fix-3 修法**（R3 plan-review
   * codex Batch A HIGH-2 升级，替代 Phase 2.7 per-session seq counter）：setPermissionMode
   * per-session 串行化 chain。
   *
   * **Phase 2.7 per-session seq 的残留 race**（codex A HIGH-2 论述 + lead 推演验证）：
   * - A: ++seq=1, oldMode='default'(原始), s.permissionMode='plan'(optimistic), await SDK 失败
   * - B 在 A 失败前进入: ++seq=2, oldMode='plan'(A optimistic 写入值,非 SDK 真值),
   *   s.permissionMode='bypassPermissions'(optimistic), await SDK 失败
   * - B catch: s.permissionModeSeq === 2 === B.seq → s.permissionMode = oldMode = 'plan'
   * - A catch: s.permissionModeSeq === 2 !== A.seq(1) → 跳过回滚 → s.permissionMode 保留 'plan'
   * - 最终 cache='plan' 但 SDK 实际仍'default'(两次都失败) → cache 与 SDK 真值脱节 →
   *   canUseTool 按脏 cache 判断 → 若 mode=bypass 安全降级
   *
   * **修法 = per-session async lock 串行化**：setPermissionMode 调用通过 chain 串行执行,前一次
   * await 完成(成功或失败)后下一次才进临界区。串行化后 oldMode 永远是上次 catch rollback 的真值
   * （永不读到他人 optimistic 写入），catch rollback 是无 race 的简单 oldMode 还原。
   *
   * **chain 设计**：用 Promise 链。`s.permissionModeChain` 是「下一次入链需 await 的 promise」，
   * 默认 undefined（无 in-flight）。caller 拿到的 Promise 仍 reject 真错给上层；chain 内部
   * `.catch(() => undefined)` 吞 throw 让 chain 不被打破（否则一次失败后 chain 永卡 reject）。
   *
   * 默认 undefined；不需清；session GC 时随 internal session 一起释放。
   */
  permissionModeChain?: Promise<unknown>;
}

/**
 * Factory：构造空白 InternalSession（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 11 字段对象字面量，集中字段初值默认逻辑
 * （permissionMode 与 query options 同源 `opts.permissionMode ?? 'default'`，详
 * permissionMode 字段 jsdoc）。query 字段 spawn 之前用 `undefined as Query` 占位，
 * applicationSid / cliSessionId 双轨化（R7 HIGH-R7-1 重命名）：applicationSid = ctor 入参
 * （spawn 主路径 = tempKey，first SDKMessage 拿到 realId 后由 stream-processor isNewSpawn
 * 分支切到 realId 后冻结 / resume 路径 = opts.resume 全程不变）；cliSessionId 初值 null，
 * 首条 SDKMessage 拿到 realId 后由 consume 写入（详 applicationSid / cliSessionId 字段 jsdoc）。
 */
export function makeInternalSession(opts: {
  cwd: string;
  permissionMode?: PermissionMode;
  applicationSid: string;
}): InternalSession {
  return {
    applicationSid: opts.applicationSid,
    cliSessionId: null,
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
    // R3 fix-3: permissionModeChain 默认 undefined（无 in-flight setPermissionMode）
  };
}
