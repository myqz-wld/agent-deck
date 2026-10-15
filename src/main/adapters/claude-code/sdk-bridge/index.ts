import { withComponentRuntimeMutation } from '@main/adapters/component-refresh/runtime-mutation';
import { requestClaudeRefresh } from '@main/adapters/component-refresh/requests';
import type { SessionComponentAction } from '@shared/session-component-refresh';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
  UploadedAttachmentRef,
  ProviderUsageSnapshot,
  SessionRecord,
} from '@shared/types';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery-types';
// Thin facade extracted from the original bridge; current node module resolution intentionally
// resolves `@main/adapters/claude-code/sdk-bridge` to this directory index.
import type { InternalSession, SdkBridgeOptions, SdkSessionHandle } from './types';
import { PermissionResponderCore } from './permission-responder-core';
import { SessionRecoverer } from './recoverer';
import {
  defaultResumeJsonlExistsCore,
  defaultResumeJsonlMtimeMsCore,
  defaultCwdExistsCore,
} from './recoverer/jsonl-discovery-core';
import { ClaudeStreamProcessorCore } from './stream-processor-core';
import { ClaudeCwdTransitionControllerCore } from './cwd-transition-controller-core';
import { RestartController } from './restart-controller';
import { SessionModelControllerCore } from '@main/adapters/session-model-controller-core';
import type {
  AgentCwdTransition,
  AgentCwdTransitionSwitchResult,
  AgentEnqueueOptions,
  PendingAgentMessage,
  PermissionMode,
  QueuedAgentMessage,
} from '@main/adapters/types';
import { isClaudeThinkingLevel } from '@shared/session-metadata';
import { createSessionImpl } from './create-session/create-session-impl';
import type { CreateSessionOpts } from './create-session/_deps';
import { readClaudeBridgeUsageSnapshotCore, readClaudeUsageSnapshotInBackgroundCore } from '../usage-snapshot-core';
import {
  closeClaudeSessionCore,
  closeClaudeSessionForRollbackCore,
  interruptClaudeSessionCore,
  retireClaudeSessionAfterCurrentTurnCore,
  setClaudePermissionModeCore,
} from './session-lifecycle-core';
import { sendClaudeMessageCore } from './message-controller-core';
import { listClaudePendingOutgoingMessagesCore, removeClaudePendingOutgoingMessageCore, snapshotClaudeQueuedMessagesForHandOffCore } from './pending-outgoing-core';
import { withResolvedClaudeGatewayCore } from './session-defaults-core';
import { listClaudeSessionCommands } from '../session-commands';
export type { SdkSessionHandle, SdkBridgeOptions } from './types';

/** Provider facade; lifecycle, input, refresh and native session setup live in focused modules. */
export class ClaudeSdkBridge {
  /** key 是真实 session_id（拿到之前用临时 id） */
  private sessions = new Map<string, InternalSession>();

  /**
   * sendMessage「断连自愈」单飞表（CHANGELOG_26 / B 方案）：sessionId → 正在跑的
   * createSession({resume,prompt}) Promise。同 sessionId 并发等同一个 Promise。
   *
   * **SHARED with restartController**（CHANGELOG_52 Step 3d / F2）：双方 mutate 同一份
   * Map，不是 recoverer 独占。详 recoverer.ts / restart-controller.ts state 节。
   */
  private recovering = new Map<string, Promise<unknown>>();

  /** 权限请求未响应自动 abort 阈值；0 = 关闭。运行时通过 setPermissionTimeoutMs 改。 */
  private permissionTimeoutMs: number;

  /** 详 permission-responder.ts —— 6 respond/list + 3 timeout 方法 sub-class。 */
  private responder: PermissionResponderCore;

  /** 详 recoverer.ts —— recoverAndSend 主体 + placeholderEmittedAt 独占 Map。 */
  private recoverer: SessionRecoverer;
  /** 详 stream-processor.ts —— makeUserMessage / createUserMessageStream / waitForRealSessionId / consume。 */
  private streamProcessor: ClaudeStreamProcessorCore;

  /** 详 restart-controller.ts —— restartWithPermissionMode + restartWithClaudeCodeSandbox 冷切。 */
  private restartController: RestartController;
  private sessionModelController: SessionModelControllerCore;
  private cwdTransitionController: ClaudeCwdTransitionControllerCore;

  constructor(private opts: SdkBridgeOptions) {
    this.permissionTimeoutMs = Math.max(0, opts.permissionTimeoutMs ?? 0);

    // RestartController 必须先 init：PermissionResponder ctx thunk 要 restart ref
    // Restart and disconnect recovery share the same provider-history probes and continuation
    // preparation seams.
    this.restartController = new RestartController({
      recovering: this.recovering, sessionHost: opts.restartSessionHost,
      emit: opts.emit,
      closeSession: (sid, closeOpts) => this.closeSession(sid, closeOpts),
      createSession: (createOpts) => this.createSession(createOpts).then((h) => h),
      jsonlExistsThunk: (cwd, sid) => this.resumeJsonlExists(cwd, sid),
      jsonlMtimeMsThunk: (cwd, sid) => this.resumeJsonlMtimeMs(cwd, sid),
      latestConversationMessageTsThunk: (sid) =>
        this.latestConversationMessageTsForSession(sid),
      captureRecoveryContinuation: (input) => this.captureRecoveryContinuation(input),
      prepareRecoveryContinuation: (input) => this.prepareRecoveryContinuation(input),
      cleanupRecoveryContinuation: (capture) => this.cleanupRecoveryContinuation(capture),
    });

    this.sessionModelController = new SessionModelControllerCore({
      operations: this.recovering,
      agentId: 'claude-code',
      emit: opts.emit,
      applyLive: async (sessionId, options, previous) => {
        const internal = this.sessions.get(sessionId);
        if (!internal) return false;
        if (options.provider !== previous.provider) {
          if (internal.userTurnInFlight) {
            throw new Error('Claude Gateway cannot change during an active turn');
          }
          opts.createSessionHost.resolveGatewayProfile(options.provider);
          await this.closeSession(sessionId);
          return true;
        }
        await internal.query.setModel(options.model ?? undefined);
        const flagSettings = {
          effortLevel: options.thinking,
        } as unknown as Parameters<InternalSession['query']['applyFlagSettings']>[0];
        await internal.query.applyFlagSettings(flagSettings);
        internal.runtimeModel = options.model ?? undefined;
        internal.runtimeEffort = isClaudeThinkingLevel(options.thinking)
          ? options.thinking
          : undefined;
        return true;
      },
    }, opts.sessionModelHost);

    this.responder = new PermissionResponderCore(
      {
        sessions: this.sessions,
        emit: opts.emit,
        getPermissionTimeoutMs: () => this.permissionTimeoutMs,
      },
      (sid, mode, prompt) => this.restartController.restartWithPermissionMode(sid, mode, prompt),
      opts.permissionResponderHost,
    );

    // arrow 闭包 this，运行时晚解析 → this.createSession 一定已绑定。
    // attachments 透传 sendMessage 第三参（HIGH-1：避免 inflight 第二条等待者丢图）。
    // CHANGELOG_99：cwdExists thunk 也走 facade extend override 模式(同 resumeJsonlExists)
    this.recoverer = new SessionRecoverer(
      { recovering: this.recovering, emit: opts.emit, sessionReader: opts.createSessionHost, sessionManager: opts.sessionManager },
      (createOpts) => this.createSession(createOpts),
      (sid, text, attachments) => this.sendMessage(sid, text, attachments),
      (cwd, sid) => this.resumeJsonlExists(cwd, sid),
      (cwd, sid) => this.resumeJsonlMtimeMs(cwd, sid),
      (cwd) => this.cwdExists(cwd),
      (sid) => this.latestConversationMessageTsForSession(sid),
      (message, error) => opts.recoveryFreshnessHost.warn(message, error),
      (input) => this.captureRecoveryContinuation(input),
      (input) => this.prepareRecoveryContinuation(input),
      (capture) => this.cleanupRecoveryContinuation(capture),
    );

    this.streamProcessor = new ClaudeStreamProcessorCore({ sessions: this.sessions, emit: opts.emit }, opts.streamProcessorHost);
    this.cwdTransitionController = new ClaudeCwdTransitionControllerCore({
      sessions: this.sessions,
      closeSession: (sessionId, options) =>
        this.closeSession(sessionId, options),
      createSession: (options) => this.createSession(options),
      capture: (input) => this.captureRecoveryContinuation(input),
      prepare: (input) => this.prepareRecoveryContinuation(input),
      cleanup: (capture) => this.cleanupRecoveryContinuation(capture),
    }, opts.cwdTransitionHost);
  }

  /** 调整超时阈值。0 = 关闭。只影响新建的 pending；老的保持原 timer。 */
  setPermissionTimeoutMs(ms: number): void {
    this.permissionTimeoutMs = Math.max(0, ms);
  }

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    return readClaudeBridgeUsageSnapshotCore(
      this.sessions, this.opts.usageSnapshotHost,
      () => readClaudeUsageSnapshotInBackgroundCore(this.opts.usageSnapshotHost),
    );
  }

  /**
   * Step 4.4 拆完后 thin delegate to `createSessionImpl`。详 `./create-session/` 子目录
   * 三子模块（_deps SSOT / create-session-impl orchestrator / create-session-sdk-query）
   * jsdoc：caller 入参签名 / 各 phase 边界 / try/catch 失败 cleanup 不变量保留。
   *
   * **decision 矛盾解决**（参照 Step 4.1 同款）：原 §保护清单 jsdoc 标记本文件不拆，
   * user plan §D1 决策强行拆 → 子模块间通过函数 return value 传递派生 state 避免巨型
   * ctx object 闭包污染（详 class 头部 jsdoc decision 矛盾解决记录）。
  */
  async createSession(opts: CreateSessionOpts): Promise<SdkSessionHandle> {
    return createSessionImpl(withResolvedClaudeGatewayCore(opts, this.opts.createSessionHost), {
      createSessionHost: this.opts.createSessionHost,
      sessionManager: this.opts.sessionManager,
      sessions: this.sessions,
      emit: this.opts.emit,
      streamProcessor: this.streamProcessor,
      sessionFinalizeHost: this.opts.sessionFinalizeHost, canUseToolHost: this.opts.canUseToolHost,
      createSessionSdkQueryHost: this.opts.createSessionSdkQueryHost,
      responder: this.responder,
      getPermissionTimeoutMs: () => this.permissionTimeoutMs,
      interrupt: (sid) => this.interrupt(sid),
      adapterId: this.opts.adapterId ?? 'claude-code',
    });
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await sendClaudeMessageCore({
      sessions: this.sessions,
      emit: this.opts.emit,
      recoverAndSend: (sid, body, refs, options) =>
        this.recoverer.recoverAndSend(sid, body, refs, options),
      makeUserMessage: (sid, body, refs) =>
        this.streamProcessor.makeUserMessage(sid, body, refs),
    }, {
      sessionId,
      text,
      attachments,
      enqueueOptions: options,
    }, this.opts.messageControllerHost);
  }

  refreshSessionComponents(sessionId: string, action: SessionComponentAction) {
    return requestClaudeRefresh(this.sessions, sessionId, action, this.opts.emit,
      this.opts.createSessionSdkQueryHost.captureComponentRefresh);
  }

  listSessionCommands(sessionId: string) {
    return listClaudeSessionCommands(this.sessions.get(sessionId)?.query ?? null);
  }
  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await sendClaudeMessageCore({
      sessions: this.sessions,
      emit: this.opts.emit,
      recoverAndSend: (sid, body, refs, options) =>
        this.recoverer.recoverAndSend(sid, body, refs, options),
      makeUserMessage: (sid, body, refs) =>
        this.streamProcessor.makeUserMessage(sid, body, refs),
    }, {
      sessionId,
      text,
      attachments,
      allowQueueOverflow: options?.bypassQueueLimit === true,
      enqueueOptions: options,
    }, this.opts.messageControllerHost);
  }

  /** Test seam around the synchronous provider-neutral recovery snapshot coordinator. */
  protected captureRecoveryContinuation(input: {
    session: SessionRecord;
    overrides?: RecoveryRuntimeOverrides;
  }): CapturedRecoveryContinuation {
    return this.opts.recoveryFreshnessHost.captureContinuation(input);
  }

  /** Test seam around bounded checkpoint/raw-tail preparation from an immutable spool. */
  protected prepareRecoveryContinuation(input: {
    capture: CapturedRecoveryContinuation;
    continuationInstruction: string;
    signal?: AbortSignal;
  }): Promise<PreparedRecoveryContinuation> {
    return this.opts.recoveryFreshnessHost.prepareContinuation(input);
  }

  /** Test seam that keeps TEMP-spool ownership with the recovery lifecycle caller. */
  protected cleanupRecoveryContinuation(capture: CapturedRecoveryContinuation): void {
    this.opts.recoveryFreshnessHost.cleanupContinuation(capture);
  }

  /**
   * 预检 CLI resume 用的 jsonl 文件是否存在。
   *
   * CHANGELOG_52 Step 3d：本方法是 facade 上的 protected wrapper，让 test 通过子类化
   * override 不依赖真 ~/.claude/projects 目录；实际实现走 module-level
   * `defaultResumeJsonlExists`（行为字节级等价）。
   *
   * 不存在时 CLI `--resume <sid>` 会 hard fail 抛 "No conversation found"，必须走不带
   * resume 的新建路径（CHANGELOG_28）。这条规则跨 OS 是否一致存疑（Linux 同样规则，
   * Windows 未验证），如果 CLI 内部规则未来改了，预检会假阴性 → 退化到原 try-and-fail 行为。
   */
  protected resumeJsonlExists(cwd: string, sessionId: string): boolean {
    return defaultResumeJsonlExistsCore(cwd, sessionId, this.opts.jsonlDiscoveryHost);
  }

  /**
   * Claude Code jsonl mtime protected wrapper。
   *
   * read-side 幻影 fork 自愈用它确认 applicationSid.jsonl 没明显落后于 DB lastEventAt；
   * 失败返回 null，helper 会退回 fresh fallback。
   */
  protected resumeJsonlMtimeMs(cwd: string, sessionId: string): number | null {
    return defaultResumeJsonlMtimeMsCore(cwd, sessionId, this.opts.jsonlDiscoveryHost);
  }

  /**
   * CHANGELOG_99 cwd 失效根治:cwd 存在性 protected wrapper。
   *
   * 让 test 通过子类化 override 不依赖真 fs(同 resumeJsonlExists 模式),实际走 module-level
   * `defaultCwdExists`(直接 existsSync,异常 fail-safe 退化返回 true 让 SDK 自己 try)。
   *
   * recoverer 拿这个判定 sessionRepo.cwd 是否还有效;不存在时走 `findFallbackCwd` 启发式
   * fallback 路径(典型场景:老 session cwd=worktree 后 worktree 被 exit_worktree 或手工删除 /
   * 用户手动 git worktree remove / 跨设备同步丢目录)。
   */
  protected cwdExists(cwd: string): boolean {
    return defaultCwdExistsCore(cwd, this.opts.jsonlDiscoveryHost);
  }

  /** Test seam for phantom-resume freshness without loading bounded message batches. */
  protected latestConversationMessageTsForSession(sessionId: string): number | null {
    return this.opts.recoveryFreshnessHost.latestConversationMessageTs(sessionId);
  }

  // CHANGELOG_52 Step 3b：6 respond/list 方法 + 3 timeout 方法迁到 PermissionResponder。
  // class 上保留薄 wrapper（保持 public API 与 timeout setTimeout 引用兼容），
  // 真正实现见 sdk-bridge/permission-responder-core.ts。

  respondPermission(sessionId: string, requestId: string, response: PermissionResponse): void {
    return this.responder.respondPermission(sessionId, requestId, response);
  }

  respondAskUserQuestion(
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): void {
    return this.responder.respondAskUserQuestion(sessionId, requestId, answer);
  }

  async respondExitPlanMode(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void> {
    return this.responder.respondExitPlanMode(sessionId, requestId, response);
  }

  listPending(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  } {
    return this.responder.listPending(sessionId);
  }

  listAllPending(): Record<
    string,
    {
      permissions: PermissionRequest[];
      askQuestions: AskUserQuestionRequest[];
      exitPlanModes: ExitPlanModeRequest[];
    }
  > {
    return this.responder.listAllPending();
  }

  async interrupt(sessionId: string): Promise<void> {
    await interruptClaudeSessionCore(this.sessions, sessionId, this.opts.sessionLifecycleHost);
  }

  armCwdTransition(transition: AgentCwdTransition): void { this.sessions.get(transition.sessionId)?.componentRefresh?.invalidate(); this.cwdTransitionController.arm(transition); }
  async switchCwdForTransition(transition: AgentCwdTransition): Promise<AgentCwdTransitionSwitchResult> {
    return this.cwdTransitionController.switchCwd(transition);
  }
  async enqueueCwdTransitionContinuation(_transition: AgentCwdTransition, _text: string): Promise<void> {
    throw new Error('Claude cwd restart must consume its provider-neutral continuation during runtime creation.');
  }

  releaseCwdTransition(sessionId: string, generation: number): void { this.cwdTransitionController.release(sessionId, generation); }

  getRuntimeCwd(sessionId: string): string | null { return this.cwdTransitionController.runtimeCwd(sessionId); }

  /** Permanent best-effort close; strict transactional proof uses closeSessionForRollback(). */
  async closeSession(sessionId: string, opts: { markRecentlyDeleted?: boolean } = {}): Promise<void> {
    this.sessions.get(sessionId)?.componentRefresh?.invalidate();
    await closeClaudeSessionCore({
      sessions: this.sessions,
      emit: this.opts.emit,
      sessionId,
      options: opts,
    }, this.opts.sessionLifecycleHost);
  }

  async closeSessionForRollback(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.componentRefresh?.invalidate();
    return closeClaudeSessionForRollbackCore({
      sessions: this.sessions,
      emit: this.opts.emit,
      sessionId,
    }, this.opts.sessionLifecycleHost);
  }
  retireSessionAfterCurrentTurn(sessionId: string): void {
    this.sessions.get(sessionId)?.componentRefresh?.invalidate();
    retireClaudeSessionAfterCurrentTurnCore(this.sessions, sessionId);
  }

  snapshotQueuedMessagesForHandOff(sessionId: string): QueuedAgentMessage[] {
    return snapshotClaudeQueuedMessagesForHandOffCore(this.sessions, sessionId);
  }

  listPendingOutgoingMessages(sessionId: string): PendingAgentMessage[] {
    return listClaudePendingOutgoingMessagesCore(this.sessions, sessionId);
  }

  removePendingOutgoingMessage(sessionId: string, messageId: string): Promise<PendingAgentMessage | null> {
    return removeClaudePendingOutgoingMessageCore(this.sessions, sessionId, messageId, this.opts.pendingOutgoingHost);
  }

  /** 运行时切换权限模式。SDK 会从下一次工具调用起按新模式判断。 */
  async setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
  ): Promise<void> {
    return withComponentRuntimeMutation(this.sessions.get(sessionId), () =>
      setClaudePermissionModeCore({ sessions: this.sessions, sessionId, mode }, this.opts.sessionLifecycleHost));
  }

  async setSessionModelOptions(
    sessionId: string,
    options: { gateway: string | null; model: string | null; thinking: string | null },
  ): Promise<void> {
    await withComponentRuntimeMutation(this.sessions.get(sessionId), () => this.sessionModelController.setOptions(sessionId, {
      provider: options.gateway,
      model: options.model,
      thinking: options.thinking,
    }));
  }

  /** 冷切权限模式 thin delegate。bypass 必须走冷切（spawn-time flag 锁死）。详 restart-controller.ts。 */
  async restartWithPermissionMode(
    sessionId: string,
    mode: PermissionMode,
    handoffPrompt: string,
  ): Promise<string> {
    return withComponentRuntimeMutation(this.sessions.get(sessionId), () =>
      this.restartController.restartWithPermissionMode(sessionId, mode, handoffPrompt));
  }

  /** 冷切 OS 沙盒 thin delegate。详 restart-controller.ts。 */
  async restartWithClaudeCodeSandbox(
    sessionId: string,
    sandbox: 'off' | 'workspace-write' | 'strict',
    handoffPrompt: string,
  ): Promise<string> {
    return withComponentRuntimeMutation(this.sessions.get(sessionId), () =>
      this.restartController.restartWithClaudeCodeSandbox(sessionId, sandbox, handoffPrompt));
  }

  /**
   * CHANGELOG_52 Step 3e：consume 实现迁到 StreamProcessor，class 上保留 protected
   * wrapper 让 sdk-bridge.test.ts 通过 cast 直接调用（与原 protected consume 一致语义）。
   */
  protected consume(
    internal: InternalSession,
    tempKey: string,
    onFirstId: (id: string) => void,
    applicationResumeId?: string,
    effectiveResumeCliSid?: string,
    resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app',
  ): Promise<string | null> {
    return this.streamProcessor.consume(
      internal,
      tempKey,
      onFirstId,
      applicationResumeId,
      effectiveResumeCliSid,
      resumeMode,
    );
  }
}
