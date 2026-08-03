// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.9 拆分:AgentAdapter 主接口 declaration(纯 declaration)。
// 收纳:AgentAdapter (init/shutdown/createSession/interruptSession/closeSession/
// sendMessage/respondPermission/respondAskUserQuestion/respondExitPlanMode/
// setPermissionMode/setCodexApprovalPolicy/restartWithPermissionMode/setCodexSandbox/
// restartWithClaudeCodeSandbox/listPending/listAllPending/setPermissionTimeoutMs/
// setCodexCliPath/installIntegration/uninstallIntegration/integrationStatus/
// receiveTeammateMessage/notifyTeammateEvent/summariseEvents)。
// ────────────────────────────────────────────────────────────────────────────

import type {
  StoredAgentEvent,
  AgentDeckTeammateEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
  ProviderUsageSnapshot,
  RuntimeSelection,
  AdapterSessionMode,
  UploadedAttachmentRef,
} from '@shared/types';

import type { AdapterContext, PermissionMode } from './adapter-context';
import type { AdapterCapabilities } from './capabilities';
import type { CreateSessionOptions } from './create-session-opts';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { TrustedContinuationSessionCandidate } from '../trusted-continuation';
import type { ForkedSessionHandle, ForkSessionSource } from './fork-session';

/** One provider input accepted by the source adapter but not yet started as a provider turn. */
export interface QueuedAgentMessage {
  text: string;
  attachments?: UploadedAttachmentRef[];
}

export interface PendingAgentMessage extends QueuedAgentMessage {
  /** Opaque renderer correlation id, present only for explicitly deferred user events. */
  id: string;
}

export interface AgentEnqueueOptions {
  /** Reserved for mandatory continuity tails already bounded by the handoff ingress gate. */
  bypassQueueLimit?: boolean;
  /** Internal consumers can correlate to execution rather than the earlier queue insertion. */
  deferUserEventUntilTurnStart?: boolean;
  /** Opaque id copied only into the correlated user event payload. */
  turnCorrelationId?: string;
  /**
   * Stable acceptance key for an internal provider turn. Once one payload is queued under this
   * key, retries acknowledge that same payload without queueing it again; a different payload is
   * rejected. This is intentionally adapter-internal and is not exposed through renderer IPC.
   */
  idempotencyKey?: string;
  /** Main-owned replay path: the corresponding user event is already durable. */
  userEventAlreadyPersisted?: boolean;
  /** Internal replay bypass after the coordinator already owns the durable transition queue. */
  bypassWorktreeTransitionGuard?: boolean;
}

export interface AgentCwdTransition {
  sessionId: string;
  generation: number;
  direction: 'enter' | 'exit';
  fromCwd: string;
  targetCwd: string;
  continuationKey: string;
  continuationText: string;
}

export interface AgentCwdTransitionSwitchResult {
  /** Claude's provider-neutral restart consumes the fixed continuation while creating the query. */
  continuationAccepted: boolean;
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  capabilities: AdapterCapabilities;

  init(ctx: AdapterContext): Promise<void>;
  shutdown(): Promise<void>;

  createSession?(opts: CreateSessionOptions): Promise<string>;
  /** Main-only fresh create path; no renderer/IPC/MCP schema can construct its branded turn. */
  createTrustedContinuationSession?(
    opts: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ): Promise<TrustedContinuationSessionCandidate>;
  /** Read-only provider eligibility checks that must run before spawn capacity is reserved. */
  validateForkSession?(
    source: ForkSessionSource,
    target: CreateSessionOptions,
  ): Promise<void>;
  /** Create a provider-native child without exposing native ids through ordinary create options. */
  createForkedSession?(
    source: ForkSessionSource,
    target: CreateSessionOptions,
  ): Promise<ForkedSessionHandle>;
  interruptSession?(sessionId: string): Promise<void>;
  /**
   * 由 SessionManager.delete 调用：abort SDK 侧 live query/turn + 清 pending Maps + 移除 internal session 记录。
   * 纯 hook-only adapter 不实现；SDK 通道 adapter（claude-code / codex-cli）均实现。
   * 不抛错（出错只 warn）：删除路径不能因为 close 失败而失败，否则 DB 行删了 bridge 状态留着会更糟。
   */
  closeSession?(sessionId: string): Promise<void>;
  /**
   * Transaction rollback close with a stronger success contract than closeSession().
   * Resolve only after provider work has stopped and adapter runtime/client ownership, SDK claims,
   * and MCP tokens are released. Reject when that state cannot be proved.
   */
  closeSessionForRollback?(sessionId: string): Promise<void>;
  /**
   * Seal queued work immediately, but let the provider finish the turn that is currently returning
   * an MCP handoff result before disposing its live runtime. This method must return without waiting
   * for the active turn, otherwise hand_off_session would deadlock on its own tool response.
   */
  retireSessionAfterCurrentTurn?(sessionId: string): void;
  /**
   * Synchronously seal the current provider input boundary. Once armed, a completed active turn
   * must not dequeue or steer another user input until releaseCwdTransition is called.
   */
  armCwdTransition?(transition: AgentCwdTransition): void;
  /** Apply a confirmed post-terminal cwd change without mutating the persisted session row. */
  switchCwdForTransition?(
    transition: AgentCwdTransition,
  ): Promise<AgentCwdTransitionSwitchResult>;
  /** Queue the fixed main-owned continuation ahead of every ordinary pending provider input. */
  enqueueCwdTransitionContinuation?(
    transition: AgentCwdTransition,
    text: string,
  ): Promise<void>;
  /** Release an armed adapter gate after switch success or compensated rollback. */
  releaseCwdTransition?(sessionId: string, generation: number): void;
  /** Runtime-only reference used by destructive exit validation. */
  getRuntimeCwd?(sessionId: string): string | null;
  sendMessage?(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void>;
  /**
   * Queue a user message for the next provider turn even when the current turn supports steering.
   * Handoff uses this to preserve the ordering between the prepared continuation turn and any
   * source inputs that arrive while the successor is being created.
   */
  enqueueMessage?(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void>;
  /** Snapshot queued, not-yet-started provider turns while a handoff ingress lease is held. */
  snapshotQueuedMessagesForHandOff?(sessionId: string): QueuedAgentMessage[];
  /** User-visible inputs that have not crossed the provider-acceptance boundary. */
  listPendingOutgoingMessages?(sessionId: string): PendingAgentMessage[];
  /** Cancel one message only before the provider-acceptance boundary wins. */
  removePendingOutgoingMessage?(
    sessionId: string,
    messageId: string,
  ): PendingAgentMessage | null | Promise<PendingAgentMessage | null>;
  /** Mid-turn steering：只修改当前正在跑的 turn，不进入下一轮 pending message queue。 */
  steerTurn?(sessionId: string, text: string): Promise<void>;
  respondPermission?(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void>;
  respondAskUserQuestion?(
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<void>;
  respondExitPlanMode?(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void>;
  setPermissionMode?(sessionId: string, mode: PermissionMode): Promise<void>;
  setSessionMode?(sessionId: string, mode: AdapterSessionMode): Promise<void>;
  /** Persist and apply the provider / model / thinking selection to subsequent turns. */
  setSessionModelOptions?(
    sessionId: string,
    options: { provider: string | null; model: string | null; thinking: string | null },
  ): Promise<void>;
  /**
   * 冷切：销毁旧 SDK 子进程 + 用新 mode 重建。`handoffPrompt` 必须非空（SDK streaming
   * 协议约束），调用方负责拼好语义。仅 bypassPermissions 必须走此路径，其他档可热切。
   * 失败时内部已 emit error message + 回滚 DB 到旧 mode，throw 仅用于上层 log。
   */
  restartWithPermissionMode?(
    sessionId: string,
    mode: PermissionMode,
    handoffPrompt: string,
  ): Promise<string>;

  /** Persist a Codex sandbox choice and apply it to subsequent turns without interrupting. */
  setCodexSandbox?(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
  ): Promise<void>;

  /**
   * Codex approval-policy next-turn apply. Persist the per-session choice and patch live thread
   * options without interrupting the active turn. Failures must roll back both projections.
   */
  setCodexApprovalPolicy?(
    sessionId: string,
    policy: 'untrusted' | 'on-request' | 'never',
  ): Promise<void>;

  /**
   * Claude Code OS 沙盒冷切（CHANGELOG_74）：销毁旧 SDK 子进程 + 用新档位 createSession
   * resume 重建。`handoffPrompt` 必须非空（SDK streaming 协议约束）。
   * 失败回滚 sessionRepo.claudeCodeSandbox。
   * capabilities.canRestartWithClaudeCodeSandbox: true 时调用方才能调此方法。
   */
  restartWithClaudeCodeSandbox?(
    sessionId: string,
    sandbox: 'off' | 'workspace-write' | 'strict',
    handoffPrompt: string,
  ): Promise<string>;

  /**
   * Restart an idle Grok ACP child with another native sandbox profile and load the same
   * provider session. null delegates to Grok's own config precedence.
   */
  restartWithGrokSandbox?(
    sessionId: string,
    sandbox: string | null,
  ): Promise<string>;

  /** 重启 / HMR 后 renderer store 会丢 pending 列表；这里给一次快照重建 UI。 */
  listPending?(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  };
  listAllPending?(): Record<string, {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  }>;
  /** 运行时调权限超时阈值（settings 改动 → bridge 即改即生效）。 */
  setPermissionTimeoutMs?(ms: number): void;
  /** Codex 专属：设置面板「Codex 二进制路径」变更时即改即生效。 */
  setCodexCliPath?(path: string | null): void;
  /** Grok Build ACP binary override; null resolves the bundled native CLI. */
  setGrokCliPath?(path: string | null): void;

  /** 数据 tab 读取 provider 订阅/限额窗口用量。未实现表示该 adapter 暂无可读来源。 */
  getUsageSnapshot?(): Promise<ProviderUsageSnapshot>;

  installIntegration?(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown>;
  uninstallIntegration?(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown>;
  integrationStatus?(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown>;

  /**
   * R3.E0 ADR §3.1 / E4 新增：把另一个 team member（来自任意 adapter）发来的消息塞进
   * 本 session 的 user turn。
   *
   * 实现约束：
   * - Promise 是 adapter queue acceptance boundary：只有在消息明确未被接受时才 reject；
   *   接受后必须 resolve。watcher 只重试明确的 pre-acceptance rejection。
   * - 接受后采用 durable **at-most-once**：状态确认失败或进程重启都不得再次注入同一 envelope。
   *   `messageId` 必须作为 adapter enqueue idempotency key，防同一 live runtime 内重复入队；
   *   该 cache 只是 defense in depth，durable restart 不依赖它。
   * - **不要**自己拼 fromMember 元信息前缀。watcher 已在 body 里拼好（统一格式见 ADR §4.4
   *   `[from <displayName> @ <adapterId>][msg <messageId>][sid <senderSessionId>]\n<原始 body>`，
   *   三段 wire prefix：`[msg]` 让 teammate reply 挂 replyToMessageId 进对话链，`[sid]`
   *   （CHANGELOG_100）让 teammate 直接 `send_message({sessionId, teamId, replyToMessageId})`
   *   回 lead）。adapter 直接 sendMessage(sessionId, body)。
   *   fromMemberId 仅用于 logging / 路由调试。
   * - 必须是异步：返回 Promise；resolve 表示「adapter message queue 已接受」（不是
   *   「session 已生成 reply」）。watcher 不等 reply。
   *
   * capability 检查：调用方必须先看 capabilities.canCollaborate；为 true 的 adapter 应实现此方法。
   * E5 watcher 在调前会 double-check：未实现 → status='failed' reason='adapter-no-collaborate'。
   */
  receiveTeammateMessage?(
    sessionId: string,
    fromMemberId: string,
    body: string,
    messageId: string,
  ): Promise<void>;

  /**
   * R3.E0 ADR §3.1 / §4.9 dispatcher：通知本 session 同 team 有 teammate 元事件
   * （teammate 加入 / 离开 / team 归档）。
   *
   * 设计为 **optional + best-effort**：adapter 可不实现（默认丢弃事件）。
   * 实现的 adapter 把事件以 system message / banner 形式插入 session
   * （如「[team] codex-helper joined」）。
   * dispatcher 不等返回，也不重试 —— 这只是观察性事件，不是关键路径。
   */
  notifyTeammateEvent?(
    sessionId: string,
    event: AgentDeckTeammateEvent,
  ): Promise<void>;

  /**
   * Periodic session-list summary. Continuation checkpoints use the isolated continuation
   * runtime and never dispatch through this display-summary API.
   */
  summariseEvents?(
    cwd: string,
    events: StoredAgentEvent[],
    evidenceContext?: string,
    runtime?: Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>,
  ): Promise<string | null>;
}
