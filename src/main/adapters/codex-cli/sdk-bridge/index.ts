import type { ProviderUsageResetRequest, ProviderUsageResetResult } from '@shared/types';
// Codex bridge facade; lifecycle, turn-loop, recovery, and restart behavior lives in sibling modules.
import { AGENT_ID } from './constants';
import type { CodexBridgeOptions, CodexSessionHandle, InternalSession } from './types';
import type { ForkedSessionHandle, ForkSessionSource } from '../../types/fork-session';
import { ThreadLoop, type ThreadLoopCtx } from './thread-loop';
import { RestartController, type RestartCtx } from './restart-controller';
import { setCodexPermissionMode } from './permission-mode-controller';
import { SessionModelControllerCore } from '@main/adapters/session-model-controller-core';
import type { SessionModelOptions } from '@main/adapters/session-model-options';
import type {
  AgentCwdTransition,
  AgentCwdTransitionSwitchResult,
  AgentEnqueueOptions,
  PendingAgentMessage,
  QueuedAgentMessage,
} from '@main/adapters/types';
import type {
  CodexApprovalPolicy,
  PermissionRequest,
  PermissionResponse,
  ProviderUsageSnapshot,
  UploadedAttachmentRef,
} from '@shared/types';
import { SessionRecoverer } from './recoverer';
import { defaultCodexResumeJsonlExists, defaultCwdExists } from './recoverer/jsonl-discovery';
import { createSessionImpl } from './create-session/create-session-impl';
import type { CreateSessionOpts } from './create-session/_deps';
import { createCodexForkedSession } from './fork-session/create-forked-session';
import type { CodexAppServerClient } from '../app-server/client';
import { MessageController } from './message-controller';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery-types';
import type { SessionRecord } from '@shared/types';
import { CodexPermissionHost } from './permission-host';
import { CodexSessionLifecycleCoordinator } from './session-lifecycle-coordinator';
import { CodexCwdTransitionController } from './cwd-transition-controller';
import { resolveCodexForkTargetRuntime } from './fork-session/target-runtime';
import { CodexSessionCommandController } from './session-command-controller';
import type { CodexHostSessionCommand } from '../session-commands';
export type { CodexSessionHandle, CodexBridgeOptions } from './types';
/** Provider-owned lifecycle and approvals; common presets are projected onto subsequent turns. */
export class CodexSdkBridge {
  /** key = 真实 thread_id（拿到前用 tempKey） */
  private sessions = new Map<string, InternalSession>();
  /** Each managed session owns its app-server client and MCP caller identity. */
  private codexBySession: Map<string, CodexAppServerClient> = new Map();
  /**
   * 与 claude `recovering` Map 同模式的单飞表。Codex sandbox 切换已不再冷重启，
   * 但仍与 recoverer 共享这张表，避免同 session 的 recover/create 与 sandbox DB/live-option
   * patch 交错。
   */
  private recovering = new Map<string, Promise<unknown>>();
  private threadLoop: ThreadLoop;
  /** Applies next-turn Codex sandbox changes without replacing the app-server thread. */
  private restartController: RestartController;
  private sessionModelController: SessionModelControllerCore;
  private messageController: MessageController;
  private permissionHost: CodexPermissionHost;
  private sessionLifecycle: CodexSessionLifecycleCoordinator;
  private cwdTransitionController: CodexCwdTransitionController;
  private sessionCommandController: CodexSessionCommandController;
  /**
   * symmetry-plan P2 HIGH-B：SessionRecoverer 持 recoverAndSend 主体。
   *
   * ctx 与 RestartController 共享 facade.recovering Map（HIGH-A 已建权威 ref）。
   * thunk 反调 facade.createSession / sendMessage / cwdExists / resumeJsonlExists（test
   * 通过 facade extend override 让单测不依赖真 fs / 真 LLM）。与 claude SessionRecoverer 同模式。
   */
  private recoverer: SessionRecoverer;
  constructor(private opts: CodexBridgeOptions) {
    this.permissionHost = new CodexPermissionHost({
      sessions: this.sessions,
      clients: this.codexBySession,
      timeoutMs: Math.max(0, opts.permissionTimeoutMs ?? 0),
      emit: opts.emit,
    });
    this.sessionLifecycle = new CodexSessionLifecycleCoordinator(
      this.sessions,
      this.codexBySession,
      (internal) => this.permissionHost.cancel(internal),
      {
        sessions: this.sessions,
        clients: this.codexBySession,
        releaseClaim: (sid) => opts.runtimeHost.sessions.releaseSdkClaim(sid),
        releaseToken: (sid) => opts.runtimeHost.tokens.release(sid),
        runtimeHost: opts.runtimeHost,
      },
    );
    const ctx: ThreadLoopCtx = {
      sessions: this.sessions,
      emit: opts.emit,
      runtimeHost: opts.runtimeHost,
      // P5 Round 1 reviewer-claude MED-1 修法 (resolveWithFallback 漏清 codexBySession + token map):
      // facade 注入 thunk 让 thread-loop 不直接 import codexBySession / mcp-session-token-map 模块。
      // 失败 swallow — fallback 路径已经在错误状态下,cleanup 失败不应再 throw 阻塞 emit 序列(thread-loop
      // resolveWithFallback 内已 catch 本 thunk 的 throw 但仍兜底)。
      cleanupTempKey: (tempKey: string) => {
        try {
          this.codexBySession.get(tempKey)?.dispose();
          this.codexBySession.delete(tempKey);
        } catch (cleanupErr) {
          opts.runtimeHost.logger('codex-bridge').warn(
            `[codex-bridge] codexBySession.delete failed in cleanupTempKey for ${tempKey}:`,
            cleanupErr,
          );
        }
        try {
          opts.runtimeHost.tokens.release(tempKey);
        } catch (cleanupErr) {
          opts.runtimeHost.logger('codex-bridge').warn(
            `[codex-bridge] mcpSessionTokenMap.release failed in cleanupTempKey for ${tempKey}:`,
            cleanupErr,
          );
        }
      },
      finalizeRetirement: (internal) => this.sessionLifecycle.finalizeOrdinary(internal),
    };
    this.threadLoop = new ThreadLoop(ctx);
    this.cwdTransitionController = new CodexCwdTransitionController({
      sessions: this.sessions,
      runTurnLoop: (session, sessionId) =>
        this.threadLoop.runTurnLoop(session, sessionId),
    });
    const restartCtx: RestartCtx = {
      recovering: this.recovering,
      emit: opts.emit,
      runtimeHost: opts.runtimeHost,
      applyLiveSandbox: (sessionId, sandbox, sandboxOpts) => {
        const internal = this.sessions.get(sessionId);
        if (!internal) return false;
        internal.thread.updateSandboxMode(sandbox, sandboxOpts);
        return true;
      },
      applyLiveApprovalPolicy: (sessionId, policy) => {
        const internal = this.sessions.get(sessionId);
        if (!internal) return false;
        internal.thread.updateApprovalPolicy(policy);
        return true;
      },
    };
    this.restartController = new RestartController(restartCtx);
    this.sessionModelController = new SessionModelControllerCore({
      operations: this.recovering,
      agentId: AGENT_ID,
      emit: opts.emit,
      canStageProviderChange: true,
      validate: (_sessionId, options, previous) => {
        if (options.provider !== previous.provider) {
          opts.runtimeHost.configuration.validateGatewayProfile(options.provider);
        }
      },
      applyLive: async (sessionId, options, previous) => {
        const internal = this.sessions.get(sessionId);
        if (!internal) return false;
        if (options.provider !== previous.provider) {
          const gateway = opts.runtimeHost.configuration.readGatewayProfile(options.provider);
          internal.thread.stageGatewayOptions({
            gatewayConfigOverrides: gateway?.configOverrides ?? null,
            modelProvider: gateway?.modelProvider ?? null,
            model: options.model ?? gateway?.defaultModel ?? null,
            effort: (options.thinking ?? gateway?.defaultThinking ?? null) as
              CreateSessionOpts['modelReasoningEffort'] | null,
          });
          return true;
        }
        await internal.thread.updateModelOptions(
          options.model,
          options.thinking as CreateSessionOpts['modelReasoningEffort'] | null,
        );
        internal.runtimeIdentity = internal.thread.getRuntimeIdentity();
        return true;
      },
    }, opts.runtimeHost.sessionModel);

    // symmetry-plan P2 HIGH-B：SessionRecoverer 装配（与 claude facade 同款 thunk 注入模式）。
    // arrow 闭包 this，运行时晚解析 → this.createSession 一定已绑定。
    // attachments 透传 sendMessage 第三参（与 claude HIGH-1 同款 — 避免 inflight 第二条等待者丢图）。
    this.recoverer = new SessionRecoverer(
      { recovering: this.recovering, emit: opts.emit, runtimeHost: opts.runtimeHost },
      (createOpts) => this.createSession(createOpts),
      (sid, text, attachments) => this.sendMessage(sid, text, attachments),
      (threadId, startedAt) => this.codexResumeJsonlExists(threadId, startedAt),
      (cwd) => this.cwdExists(cwd),
      (session, overrides) => this.captureRecoveryContext(session, overrides),
      (capture, instruction) => this.prepareRecoveryContext(capture, instruction),
      (capture) => this.cleanupRecoveryContext(capture),
    );
    this.messageController = new MessageController({
      sessions: this.sessions,
      emit: opts.emit,
      runtimeHost: opts.runtimeHost,
      recoverAndSend: (sessionId, text, attachments, options) =>
        this.recoverer.recoverAndSend(sessionId, text, attachments, options),
      runTurnLoop: (session, sessionId) => this.threadLoop.runTurnLoop(session, sessionId),
    });
    this.sessionCommandController = new CodexSessionCommandController({
      sessions: this.sessions,
      emit: opts.emit,
      runtimeHost: opts.runtimeHost,
      runTurnLoop: (session, sessionId) => this.threadLoop.runTurnLoop(session, sessionId),
    });
  }
  setCodexCliPath(_path: string | null): void {
    this.opts.runtimeHost.clientRegistry.invalidateForPathChange(
      this.codexBySession,
      this.sessions,
    );
  }

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    return this.opts.runtimeHost.clientRegistry.getUsageSnapshot(this.codexBySession);
  }

  async consumeUsageReset(request: ProviderUsageResetRequest): Promise<ProviderUsageResetResult> {
    const consume = this.opts.runtimeHost.clientRegistry.consumeUsageReset;
    if (!consume) throw new Error('当前 Codex CLI 暂不支持额度重置');
    return consume(this.codexBySession, request);
  }

  private async ensureCodex(
    sessionId: string,
    sessionToken: string,
  ): Promise<CodexAppServerClient> {
    const client = this.opts.runtimeHost.clientRegistry.ensureClient({
      clients: this.codexBySession,
      sessionId,
      sessionToken,
      hookServer: this.opts.hookServer,
    });
    this.permissionHost.bindClient(client);
    return client;
  }

  renameCodexInstance(oldId: string, newId: string): void {
    this.opts.runtimeHost.clientRegistry.renameClient(this.codexBySession, oldId, newId);
  }

  async createSession(opts: CreateSessionOpts): Promise<CodexSessionHandle> {
    // Phase 4 Step 4.3 — facade thin delegate (详 create-session/_deps.ts §拆分布局)。
    // 字段 jsdoc SSOT 在 CreateSessionOpts interface(create-session/_deps.ts);
    // method 主体抽到 createSessionImpl orchestrator → validate / resume / new 3 子段。
    return createSessionImpl(opts, {
      sessions: this.sessions,
      codexBySession: this.codexBySession,
      threadLoop: this.threadLoop,
      emit: this.opts.emit,
      runtimeHost: this.opts.runtimeHost,
      // arrow 闭包 facade `this`,运行时晚解析 → this.ensureCodex 一定已绑定
      ensureCodex: (sid, token) => this.ensureCodex(sid, token),
    });
  }

  validateForkSession(source: ForkSessionSource): void {
    this.sessionLifecycle.validateForkSource(source);
  }

  createForkedSession(
    source: ForkSessionSource,
    target: CreateSessionOpts,
  ): Promise<ForkedSessionHandle> {
    return createCodexForkedSession(source, target, {
      sessions: this.sessions,
      codexBySession: this.codexBySession,
      threadLoop: this.threadLoop,
      emit: this.opts.emit,
      runtimeHost: this.opts.runtimeHost,
      ensureCodex: (sid, token) => this.ensureCodex(sid, token),
      resolveTargetRuntime: (opts) => resolveCodexForkTargetRuntime(opts, {
        defaultSandboxMode: this.opts.runtimeHost.configuration.readDefaultSandbox(),
        developerInstructions:
          this.opts.runtimeHost.configuration.readApplicationInstructions(),
        readConfiguredModel: this.opts.runtimeHost.configuration.readConfiguredModel,
        readConfiguredReasoningEffort:
          this.opts.runtimeHost.configuration.readConfiguredReasoningEffort,
        readGatewayProfile: this.opts.runtimeHost.configuration.readGatewayProfile,
      }),
      lifecycle: {
        allocateToken: (sid) => this.opts.runtimeHost.tokens.allocate(sid),
        resolveToken: (token) => this.opts.runtimeHost.tokens.get(token),
        releaseToken: (sid) => this.opts.runtimeHost.tokens.release(sid),
        claimSession: (sid) => this.opts.runtimeHost.sessions.claimAsSdk(sid),
        releaseClaim: (sid) => this.opts.runtimeHost.sessions.releaseSdkClaim(sid),
        hasClaim: (sid) => this.opts.runtimeHost.sessions.hasSdkClaim(sid),
        renameSession: (from, to) => this.opts.runtimeHost.sessions.renameSdkSession(from, to),
        deleteSession: (sid) => this.opts.runtimeHost.sessions.delete(sid),
      },
    });
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await this.messageController.sendMessage(sessionId, text, attachments, options);
  }

  executeSessionCommand(
    sessionId: string,
    command: CodexHostSessionCommand,
  ): Promise<void> {
    return this.sessionCommandController.execute(sessionId, command);
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await this.messageController.enqueueMessage(sessionId, text, attachments, options);
  }

  async steerTurn(sessionId: string, text: string, attachments?: UploadedAttachmentRef[]): Promise<void> {
    await this.messageController.steerTurn(sessionId, text, attachments);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.messageController.interrupt(sessionId);
  }

  armCwdTransition(transition: AgentCwdTransition): void {
    this.cwdTransitionController.arm(transition);
  }

  async switchCwdForTransition(transition: AgentCwdTransition): Promise<AgentCwdTransitionSwitchResult> {
    this.cwdTransitionController.switchCwd(transition);
    return { continuationAccepted: false };
  }

  async enqueueCwdTransitionContinuation(transition: AgentCwdTransition, text: string): Promise<void> {
    this.cwdTransitionController.enqueueContinuation(transition, text);
  }

  releaseCwdTransition(sessionId: string, generation: number): void {
    this.cwdTransitionController.release(sessionId, generation);
  }

  getRuntimeCwd(sessionId: string): string | null {
    return this.cwdTransitionController.runtimeCwd(sessionId);
  }

  /** Finish the current provider turn, but never start queued work on a handed-off source. */
  retireSessionAfterCurrentTurn(sessionId: string): void {
    this.sessionLifecycle.retireAfterCurrentTurn(sessionId);
  }

  snapshotQueuedMessagesForHandOff(sessionId: string): QueuedAgentMessage[] {
    return this.messageController.snapshotQueuedMessagesForHandOff(sessionId);
  }

  listPendingOutgoingMessages(sessionId: string): PendingAgentMessage[] {
    return this.messageController.listPendingOutgoingMessages(sessionId);
  }

  removePendingOutgoingMessage(sessionId: string, messageId: string): PendingAgentMessage | null {
    return this.messageController.removePendingOutgoingMessage(sessionId, messageId);
  }

  /** Persist and apply the Codex sandbox to the next turn without restarting app-server. */
  async setCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
  ): Promise<void> {
    return this.restartController.setCodexSandbox(sessionId, sandbox);
  }

  async setCodexApprovalPolicy(
    sessionId: string,
    policy: CodexApprovalPolicy,
  ): Promise<void> {
    await this.restartController.setCodexApprovalPolicy(sessionId, policy);
  }

  async setPermissionMode(sessionId: string, mode: import('@shared/types').PermissionMode): Promise<void> {
    await setCodexPermissionMode(sessionId, mode, {
      operations: this.recovering,
      records: this.opts.runtimeHost.records,
      applyLive: (id, next) => this.sessions.get(id)?.thread.updatePermissionMode(next),
    });
  }

  async setSessionModelOptions(sessionId: string, options: SessionModelOptions): Promise<void> {
    await this.sessionModelController.setOptions(sessionId, options);
  }

  /** Permanent best-effort close; strict transactional proof uses closeSessionForRollback(). */
  async closeSession(sessionId: string): Promise<void> {
    await this.sessionLifecycle.closeOrdinary(sessionId);
  }

  async closeSessionForRollback(sessionId: string): Promise<void> {
    await this.sessionLifecycle.closeForRollback(sessionId);
  }

  respondPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): void {
    this.permissionHost.respond(sessionId, requestId, response);
  }

  listPending(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: never[];
    exitPlanModes: never[];
  } {
    return {
      permissions: this.permissionHost.list(sessionId),
      askQuestions: [],
      exitPlanModes: [],
    };
  }

  listAllPending(): Record<
    string,
    { permissions: PermissionRequest[]; askQuestions: never[]; exitPlanModes: never[] }
  > {
    return this.permissionHost.listAll();
  }

  setPermissionTimeoutMs(ms: number): void {
    this.permissionHost.setTimeoutMs(ms);
  }

  /**
   * symmetry-plan P2 HIGH-B：codex jsonl 预检 protected wrapper（与 claude
   * `resumeJsonlExists` 同款 facade extend override 模式）。
   *
   * 让 test 通过子类化 override 不依赖真 ~/.codex/sessions 目录；实际走 module-level
   * `defaultCodexResumeJsonlExists`（扫 startedAt 日期目录 + ±1 day 找 *-<threadId>.jsonl）。
   *
   * recoverer 拿这个判定 codex CLI resume 用的 jsonl 是否还在；不在时走 fallback 路径
   * （createSession 不带 resume + 后置 renameSdkSession 把应用层 events / file_changes /
   * summaries 子表迁过去）。
   */
  protected codexResumeJsonlExists(threadId: string, startedAt: number): boolean {
    return defaultCodexResumeJsonlExists(threadId, startedAt);
  }

  /**
   * symmetry-plan P2 LOW-A：cwd 存在性 protected wrapper（与 claude `cwdExists` 同款）。
   *
   * 让 test 通过子类化 override 不依赖真 fs；实际走 module-level `defaultCwdExists`
   * （直接 existsSync，异常 fail-safe 退化返回 true 让 SDK 自己 try）。
   *
   * recoverer 拿这个判定 sessionRepo.cwd 是否还有效；不存在时走 `findFallbackCwd` 启发式
   * fallback 路径（典型：老 session cwd=worktree 后 worktree 被 exit_worktree 或手工删除 /
   * 用户手动 git worktree remove / 跨设备同步丢目录）。
   */
  protected cwdExists(cwd: string): boolean {
    return defaultCwdExists(cwd);
  }

  /** Test seam around the synchronous pre-emit TEMP-spool capture. */
  protected captureRecoveryContext(
    session: SessionRecord,
    overrides?: RecoveryRuntimeOverrides,
  ): CapturedRecoveryContinuation {
    return this.opts.recoveryContinuationHost.captureContinuation({ session, overrides });
  }

  /** Test seam around the shared provider-neutral recovery preparation. */
  protected prepareRecoveryContext(
    capture: CapturedRecoveryContinuation,
    continuationInstruction: string,
  ): Promise<PreparedRecoveryContinuation> {
    return this.opts.recoveryContinuationHost.prepareContinuation({
      capture,
      continuationInstruction,
    });
  }

  /** Test seam around idempotent TEMP-spool cleanup. */
  protected cleanupRecoveryContext(capture: CapturedRecoveryContinuation): void {
    this.opts.recoveryContinuationHost.cleanupContinuation(capture);
  }
}
