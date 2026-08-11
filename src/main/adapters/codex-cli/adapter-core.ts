import type {
  AgentAdapter,
  AgentCwdTransition,
  AgentCwdTransitionSwitchResult,
  AgentEnqueueOptions,
  AdapterContext,
  CodexCreateOpts,
  CreateSessionOptions,
  ForkedSessionHandle,
  ForkSessionSource,
} from '../types';
import type {
  StoredAgentEvent,
  CodexApprovalPolicy,
  ProviderUsageSnapshot,
  PermissionResponse,
  RuntimeSelection,
  UploadedAttachmentRef,
} from '@shared/types';
import type { CodexSdkBridge } from './sdk-bridge';
import { unavailableUsageSnapshot } from '../provider-usage';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import { getAdapterRuntimeProfile } from '../runtime-profiles';
import {
  TrustedContinuationAcceptanceController,
  trustedContinuationCandidate,
  type TrustedContinuationSessionCandidate,
} from '../trusted-continuation';
import {
  createCodexAdapterBridgeWithHost,
  type CodexAdapterInitHost,
} from './adapter-init-core';

const ADAPTER_ID = 'codex-cli';

export interface CodexHookIntegration {
  install(options: { scope: 'user' | 'project'; cwd?: string }): unknown;
  uninstall(options: { scope: 'user' | 'project'; cwd?: string }): unknown;
  status(options: { scope: 'user' | 'project'; cwd?: string }): unknown;
}

export interface CodexCliAdapterHost {
  readonly bridge: CodexAdapterInitHost<CodexSdkBridge>;
  createHookIntegration(context: AdapterContext): CodexHookIntegration;
  registerHookRoutes(context: AdapterContext, adapterId: string): void;
  resolveProvider(provider: string | null | undefined): string | undefined;
  summariseEvents(
    cwd: string,
    events: StoredAgentEvent[],
    evidenceContext?: string,
    runtime?: Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>,
  ): Promise<string | null>;
}

/**
 * Codex CLI 适配器（基于 `codex app-server --stdio`）。
 *
 * 能力边界（与 plan 对齐）：
 * - ✅ createSession / sendMessage / interrupt / resume / 事件流
 * - ✅ hook installer + hook routes for external terminal Codex sessions
 * - ✅ app-server native command / file / permission / MCP tool approval requests
 * - ❌ 通用 AskUserQuestion / ExitPlanMode（MCP tool approval 的 requestUserInput
 *   由 permission queue 单独承接）
 * - ❌ 通用 setPermissionMode
 * - ✅ Codex approvalPolicy 可持久化热切，下一次 turn/start 生效
 *
 * 新建会话的 approval policy 默认 `never`；caller 显式值和同 adapter 继承值优先。
 * reviewer 名称不隐式改变权限、审批或沙盒。sandboxMode 默认 'workspace-write' 但
 * **可被 settings.codexSandbox 覆盖**
 * （CHANGELOG_54 B-4：补齐 REVIEW_14「双 backend 沙盒对称」目标，让用户能在 read-only /
 * workspace-write / danger-full-access 三档间切）。靠 OS sandbox 兜底。
 *
 * 二进制：直接依赖 @openai/codex（含 vendored 平台二进制 ~150MB），
 * 跟随 .app 走。用户可在设置面板填 codexCliPath 覆盖为外部 codex（如自装的更新版本）。
 */
export class CodexCliAdapter implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = getAdapterRuntimeProfile(ADAPTER_ID).displayName;
  capabilities = { ...getAdapterRuntimeProfile(ADAPTER_ID).capabilities };

  /**
   * codex bridge 实例。
   *
   * **可见性**（plan codex-handoff-team-alignment-20260518 P2 Step 2.8）：从 `private` 改为
   * 默认（class 内部字段无访问修饰符 = public）让 main bootstrap 注入的
   * `setSessionRenameHookFn` 能 cast access `adapter.bridge?.renameCodexInstance` 同步 rename
   * codexBySession Map key(不变量 7:sessionManager.renameSdkSession 函数体内统一调,
   * 与 sdkOwned / token map / sessions Map / per-session Codex 实例 Map 四处 key 同步)。
   *
   * 不加进 AgentAdapter interface(避免 claude adapter 也得 noop 实现一份污染契约) —
   * codex 是唯一需要 per-session bridge instance rename 的 adapter,通过 cast 探测特化。
   */
  bridge: CodexSdkBridge | null = null;
  private installer: CodexHookIntegration | null = null;

  constructor(private readonly host: CodexCliAdapterHost) {}

  async init(ctx: AdapterContext): Promise<void> {
    // CHANGELOG_<X> R2 / B'4：把 ctx.hookServer 传给 bridge，让 ensureCodex 在 spawn
    // codex CLI 时通过 SDK config 字段注入 mcp_servers.agent-deck（连接到本应用 /mcp）。
    this.bridge = createCodexAdapterBridgeWithHost(
      this.host.bridge,
      ctx.emit,
      ctx.hookServer,
    );
    // Desktop host 启动时读一次 codexCliPath 并应用到 bridge；codexSandbox 不在这里透传，
    // bridge createSession 的 runtime-selection host 会按 turn 读取，避免 in-memory mirror。
    this.installer = this.host.createHookIntegration(ctx);
    this.host.registerHookRoutes(ctx, this.id);
  }

  async shutdown(): Promise<void> {
    // 没有需要主动关闭的资源（codex SDK 子进程是 per-turn spawn，turn 结束自动清理）
  }

  async createSession(opts: CodexCreateOpts & { agentId: 'codex-cli' }): Promise<string> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    const provider = this.host.resolveProvider(opts.provider);
    const handle = await this.bridge.createSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      provider,
      resume: opts.resume,
      codexSandbox: opts.codexSandbox,
      attachments: opts.attachments,
      model: opts.model,
      modelReasoningEffort: opts.modelReasoningEffort,
      developerInstructions: opts.developerInstructions,
      codexConfigOverrides: opts.codexConfigOverrides,
      extraAllowWrite: opts.extraAllowWrite,
      // plan codex-handoff-team-alignment-20260518 §P3 Step 3.5: 4 个新字段（codex teammate
      // spawn default 由 options-builder narrowToCodexOpts spread；此处只透传不主动 enforce）
      approvalPolicy: opts.approvalPolicy,
      networkAccessEnabled: opts.networkAccessEnabled,
      additionalDirectories: opts.additionalDirectories,
      // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 7 步(facade wrapper):
      // 显式 spread handOff,否则 facade 白名单 spread 会丢字段 → bridge 拿不到 metadata。
      handOff: opts.handOff,
      awaitCanonicalId: opts.awaitCanonicalId,
      initialSessionRegistration: opts.initialSessionRegistration,
    });
    return handle.sessionId;
  }

  async createTrustedContinuationSession(
    opts: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ): Promise<TrustedContinuationSessionCandidate> {
    if (opts.agentId !== ADAPTER_ID || !this.bridge) {
      throw new Error('Codex trusted continuation requires an initialized Codex adapter');
    }
    const provider = this.host.resolveProvider(opts.provider);
    const acceptance = new TrustedContinuationAcceptanceController();
    const handle = await this.bridge.createSession({
      cwd: opts.cwd,
      trustedContinuation: turn,
      trustedContinuationAcceptance: acceptance,
      provider,
      codexSandbox: opts.codexSandbox,
      attachments: opts.attachments,
      model: opts.model,
      modelReasoningEffort: opts.modelReasoningEffort,
      developerInstructions: opts.developerInstructions,
      codexConfigOverrides: opts.codexConfigOverrides,
      extraAllowWrite: opts.extraAllowWrite,
      approvalPolicy: opts.approvalPolicy,
      networkAccessEnabled: opts.networkAccessEnabled,
      additionalDirectories: opts.additionalDirectories,
      handOff: opts.handOff,
      awaitCanonicalId: opts.awaitCanonicalId,
      initialSessionRegistration: opts.initialSessionRegistration,
    });
    return trustedContinuationCandidate(handle.sessionId, acceptance);
  }

  async validateForkSession(
    source: ForkSessionSource,
    target: CreateSessionOptions,
  ): Promise<void> {
    if (target.agentId !== ADAPTER_ID) {
      throw new Error(`Codex native fork received target adapter ${target.agentId}.`);
    }
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    this.host.resolveProvider(target.provider);
    this.bridge.validateForkSession(source);
  }

  async createForkedSession(
    source: ForkSessionSource,
    target: CreateSessionOptions,
  ): Promise<ForkedSessionHandle> {
    if (target.agentId !== ADAPTER_ID) {
      throw new Error(`Codex native fork received target adapter ${target.agentId}.`);
    }
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    const provider = this.host.resolveProvider(target.provider);
    return this.bridge.createForkedSession(source, {
      cwd: target.cwd,
      prompt: target.prompt,
      provider,
      codexSandbox: target.codexSandbox,
      attachments: target.attachments,
      model: target.model,
      modelReasoningEffort: target.modelReasoningEffort,
      developerInstructions: target.developerInstructions,
      codexConfigOverrides: target.codexConfigOverrides,
      extraAllowWrite: target.extraAllowWrite,
      approvalPolicy: target.approvalPolicy,
      networkAccessEnabled: target.networkAccessEnabled,
      additionalDirectories: target.additionalDirectories,
      handOff: target.handOff,
      awaitCanonicalId: true,
      initialSessionRegistration: target.initialSessionRegistration,
    });
  }

  async interruptSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.closeSession(sessionId);
  }

  async closeSessionForRollback(sessionId: string): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.closeSessionForRollback(sessionId);
  }

  retireSessionAfterCurrentTurn(sessionId: string): void {
    this.bridge?.retireSessionAfterCurrentTurn(sessionId);
  }

  armCwdTransition(transition: AgentCwdTransition): void {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    this.bridge.armCwdTransition(transition);
  }

  async switchCwdForTransition(
    transition: AgentCwdTransition,
  ): Promise<AgentCwdTransitionSwitchResult> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    return this.bridge.switchCwdForTransition(transition);
  }

  async enqueueCwdTransitionContinuation(
    transition: AgentCwdTransition,
    text: string,
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.enqueueCwdTransitionContinuation(transition, text);
  }

  releaseCwdTransition(sessionId: string, generation: number): void {
    this.bridge?.releaseCwdTransition(sessionId, generation);
  }

  getRuntimeCwd(sessionId: string): string | null {
    return this.bridge?.getRuntimeCwd(sessionId) ?? null;
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.sendMessage(sessionId, text, attachments, options);
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.enqueueMessage(sessionId, text, attachments, options);
  }

  snapshotQueuedMessagesForHandOff(sessionId: string) {
    return this.bridge?.snapshotQueuedMessagesForHandOff(sessionId) ?? [];
  }

  listPendingOutgoingMessages(sessionId: string) {
    return this.bridge?.listPendingOutgoingMessages(sessionId) ?? [];
  }

  removePendingOutgoingMessage(sessionId: string, messageId: string) {
    return this.bridge?.removePendingOutgoingMessage(sessionId, messageId) ?? null;
  }

  async steerTurn(sessionId: string, text: string): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.steerTurn(sessionId, text);
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void> {
    this.bridge?.respondPermission(sessionId, requestId, response);
  }

  async setSessionModelOptions(
    sessionId: string,
    options: { provider: string | null; model: string | null; thinking: string | null },
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.setSessionModelOptions(sessionId, options);
  }

  /**
   * R3.E4：receiveTeammateMessage = 调本 adapter 的 sendMessage。
   * watcher 已在 body 里拼好 `[from <displayName> @ <adapterId>]` 前缀，直接透传。
   * fromMemberId 仅用于 logging。
   *
   * 注意 §7.5 backpressure 配套：codex SDK 的 MAX_PENDING_MESSAGES=20 队列有上限，
   * watcher 的 mcpMessageMaxTargetInflight 设默认 10 防灌爆（settings 可调）。
   */
  async receiveTeammateMessage(
    sessionId: string,
    _fromMemberId: string,
    body: string,
    messageId: string,
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.sendMessage(
      sessionId,
      body,
      undefined,
      { idempotencyKey: messageId },
    );
  }

  listPending(sessionId: string) {
    if (!this.bridge) return { permissions: [], askQuestions: [], exitPlanModes: [] };
    return this.bridge.listPending(sessionId);
  }

  listAllPending() {
    if (!this.bridge) return {};
    return this.bridge.listAllPending();
  }

  setPermissionTimeoutMs(ms: number): void {
    this.bridge?.setPermissionTimeoutMs(ms);
  }

  /** Codex 专属：设置面板「Codex 二进制路径」变更时即改即生效。 */
  setCodexCliPath(path: string | null): void {
    this.bridge?.setCodexCliPath(path);
  }

  async installIntegration(opts: { scope: 'user' | 'project'; cwd?: string }): Promise<unknown> {
    if (!this.installer) throw new Error('codex-cli adapter not initialized');
    return this.installer.install(opts);
  }

  async uninstallIntegration(opts: { scope: 'user' | 'project'; cwd?: string }): Promise<unknown> {
    if (!this.installer) throw new Error('codex-cli adapter not initialized');
    return this.installer.uninstall(opts);
  }

  async integrationStatus(opts: { scope: 'user' | 'project'; cwd?: string }): Promise<unknown> {
    if (!this.installer) throw new Error('codex-cli adapter not initialized');
    return this.installer.status(opts);
  }

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    if (!this.bridge) {
      return unavailableUsageSnapshot(
        'codex-cli',
        'Codex 暂时无法读取额度信息',
      );
    }
    return this.bridge.getUsageSnapshot();
  }

  /** Persist and apply a Codex sandbox selection to subsequent turns. */
  async setCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    return this.bridge.setCodexSandbox(sessionId, sandbox);
  }

  /** Persist a Codex approval policy and apply it to the next app-server turn. */
  async setCodexApprovalPolicy(
    sessionId: string,
    policy: CodexApprovalPolicy,
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.setCodexApprovalPolicy(sessionId, policy);
  }

  /** Periodic session-list summary; continuation checkpoints use the isolated runtime. */
  async summariseEvents(
    cwd: string,
    events: StoredAgentEvent[],
    evidenceContext?: string,
    runtime?: Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>,
  ): Promise<string | null> {
    return this.host.summariseEvents(cwd, events, evidenceContext, runtime);
  }

  // 不实现：通用 respondAskUserQuestion / respondExitPlanMode / setPermissionMode。
  // MCP tool approval 的 requestUserInput 复用 respondPermission。
}

/**
 * Typed export（D2）：caller `adapterRegistry.get('codex-cli')` 拿到本 class 实例后,
 * 自动暴露 codex 专属方法（setCodexApprovalPolicy / setCodexSandbox /
 * setCodexCliPath 等）TS visible。
 */
