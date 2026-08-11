import type {
  AgentAdapter,
  AgentCwdTransition,
  AgentCwdTransitionSwitchResult,
  AgentEnqueueOptions,
  AdapterContext,
  GrokCreateOpts,
  CreateSessionOptions,
} from '../types';
import type {
  AdapterSessionMode,
  StoredAgentEvent,
  PermissionResponse,
  ProviderUsageSnapshot,
  UploadedAttachmentRef,
} from '@shared/types';
import { unavailableUsageSnapshot } from '../provider-usage';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';

import { getAdapterRuntimeProfile } from '../runtime-profiles';
import type { GrokBuildBridge } from './bridge';
import {
  TrustedContinuationAcceptanceController,
  trustedContinuationCandidate,
  type TrustedContinuationSessionCandidate,
} from '../trusted-continuation';
import {
  createGrokAdapterBridgeWithHost,
  resolveGrokCreateSandboxWithHost,
  type GrokAdapterHost,
} from './adapter-host-core';

const ADAPTER_ID = 'grok-build';

export interface GrokHookIntegration {
  install(options: { scope: 'user' | 'project'; cwd?: string }): unknown;
  uninstall(options: { scope: 'user' | 'project'; cwd?: string }): unknown;
  status(options: { scope: 'user' | 'project'; cwd?: string }): unknown;
}

export interface GrokBuildAdapterHost {
  readonly bridge: GrokAdapterHost<GrokBuildBridge>;
  createHookIntegration(context: AdapterContext): GrokHookIntegration;
  registerHookRoutes(context: AdapterContext, adapterId: string): void;
  reportCapabilityProbeSkipped(error: unknown): void;
  summariseEvents(
    cwd: string,
    events: StoredAgentEvent[],
    evidenceContext?: string,
    runtime?: { provider?: string; model?: string; thinking?: string },
  ): Promise<string | null>;
}

export class GrokBuildAdapter implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = getAdapterRuntimeProfile(ADAPTER_ID).displayName;
  capabilities = { ...getAdapterRuntimeProfile(ADAPTER_ID).capabilities };

  private bridge: GrokBuildBridge | null = null;
  private installer: GrokHookIntegration | null = null;

  constructor(private readonly host: GrokBuildAdapterHost) {}

  async init(ctx: AdapterContext): Promise<void> {
    this.installer = this.host.createHookIntegration(ctx);
    this.host.registerHookRoutes(ctx, this.id);

    this.bridge = createGrokAdapterBridgeWithHost(
      this.host.bridge,
      ctx.emit,
      `http://127.0.0.1:${ctx.hookServer.listeningPort}/mcp`,
      (supported) => {
        this.capabilities.canAcceptAttachments = supported;
        getAdapterRuntimeProfile(ADAPTER_ID).capabilities.canAcceptAttachments = supported;
      },
    );

    // Capability discovery is local and free. A missing CLI should not disable the rest of Agent Deck.
    try {
      await this.bridge.probeCapabilities(ctx.paths.userHome);
    } catch (error) {
      this.host.reportCapabilityProbeSkipped(error);
    }
  }

  async shutdown(): Promise<void> {
    await this.bridge?.shutdown();
    this.bridge = null;
    this.installer = null;
  }

  async createSession(
    opts: GrokCreateOpts & { agentId: 'grok-build' },
  ): Promise<string> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    return this.bridge.createSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resume: opts.resume,
      teamName: opts.teamName,
      attachments: opts.attachments,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      sessionMode: opts.sessionMode,
      grokSandbox: resolveGrokCreateSandboxWithHost(
        this.host.bridge,
        opts.grokSandbox,
        opts.resume,
      ),
      grokAgentName: opts.grokAgentName,
      grokAgentSource: opts.grokAgentSource,
      grokPluginDir: opts.grokPluginDir,
      handOff: opts.handOff,
      awaitCanonicalId: opts.awaitCanonicalId,
      initialSessionRegistration: opts.initialSessionRegistration,
    });
  }

  async createTrustedContinuationSession(
    opts: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ): Promise<TrustedContinuationSessionCandidate> {
    if (opts.agentId !== ADAPTER_ID || !this.bridge) {
      throw new Error('Grok trusted continuation requires an initialized Grok adapter.');
    }
    const acceptance = new TrustedContinuationAcceptanceController();
    const sessionId = await this.bridge.createTrustedContinuationSession(
      {
        cwd: opts.cwd,
        attachments: opts.attachments,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        sessionMode: opts.sessionMode,
        grokSandbox: resolveGrokCreateSandboxWithHost(
          this.host.bridge,
          opts.grokSandbox,
          opts.resume,
        ),
        grokAgentName: opts.grokAgentName,
        grokAgentSource: opts.grokAgentSource,
        grokPluginDir: opts.grokPluginDir,
        handOff: opts.handOff,
        awaitCanonicalId: opts.awaitCanonicalId,
        initialSessionRegistration: opts.initialSessionRegistration,
      },
      turn,
      acceptance,
    );
    return trustedContinuationCandidate(sessionId, acceptance);
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.bridge?.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.bridge?.closeSession(sessionId);
  }

  async closeSessionForRollback(sessionId: string): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.closeSessionForRollback(sessionId);
  }

  retireSessionAfterCurrentTurn(sessionId: string): void {
    this.bridge?.retireSessionAfterCurrentTurn(sessionId);
  }

  armCwdTransition(transition: AgentCwdTransition): void {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    this.bridge.armCwdTransition(transition);
  }

  async switchCwdForTransition(
    transition: AgentCwdTransition,
  ): Promise<AgentCwdTransitionSwitchResult> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    return this.bridge.switchCwdForTransition(transition);
  }

  async enqueueCwdTransitionContinuation(
    transition: AgentCwdTransition,
    text: string,
  ): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
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
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.sendMessage(sessionId, text, attachments, options);
  }

  canAcceptSessionAttachments(sessionId: string): boolean | null {
    return this.bridge?.canAcceptSessionAttachments(sessionId) ?? null;
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.enqueueMessage(sessionId, text, attachments, options);
  }

  async steerTurn(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.steerTurn(sessionId, text, attachments);
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

  async receiveTeammateMessage(
    sessionId: string,
    _fromMemberId: string,
    body: string,
    messageId: string,
  ): Promise<void> {
    await this.sendMessage(
      sessionId,
      body,
      undefined,
      { idempotencyKey: messageId },
    );
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
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.setSessionModelOptions(sessionId, options);
  }

  async setSessionMode(sessionId: string, mode: AdapterSessionMode): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.setSessionMode(sessionId, mode);
  }

  async restartWithGrokSandbox(
    sessionId: string,
    sandbox: string | null,
  ): Promise<string> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    return this.bridge.restartWithGrokSandbox(sessionId, sandbox);
  }

  listPending(sessionId: string) {
    return {
      permissions: this.bridge?.listPending(sessionId).permissions ?? [],
      askQuestions: [],
      exitPlanModes: [],
    };
  }

  listAllPending() {
    const pending = this.bridge?.listAllPending() ?? {};
    return Object.fromEntries(
      Object.entries(pending).map(([sessionId, value]) => [
        sessionId,
        { permissions: value.permissions, askQuestions: [], exitPlanModes: [] },
      ]),
    );
  }

  setPermissionTimeoutMs(ms: number): void {
    this.bridge?.setPermissionTimeoutMs(ms);
  }

  setGrokCliPath(path: string | null): void {
    this.bridge?.setBinaryPath(path);
  }

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    if (!this.bridge) {
      return unavailableUsageSnapshot(
        'grok-build',
        'Grok 暂时无法读取额度信息',
      );
    }
    return this.bridge.getUsageSnapshot();
  }

  async installIntegration(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown> {
    if (!this.installer) throw new Error('Grok Build adapter is not initialized.');
    return this.installer.install(opts);
  }

  async uninstallIntegration(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown> {
    if (!this.installer) throw new Error('Grok Build adapter is not initialized.');
    return this.installer.uninstall(opts);
  }

  async integrationStatus(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown> {
    if (!this.installer) throw new Error('Grok Build adapter is not initialized.');
    return this.installer.status(opts);
  }

  /** Periodic session-list summary; continuation checkpoints use the isolated runtime. */
  async summariseEvents(
    cwd: string,
    events: StoredAgentEvent[],
    evidenceContext?: string,
    runtime?: { provider?: string; model?: string; thinking?: string },
  ): Promise<string | null> {
    if (runtime?.provider) {
      throw new Error('grok-build does not support a separate runtime provider');
    }
    return this.host.summariseEvents(cwd, events, evidenceContext, runtime);
  }
}
