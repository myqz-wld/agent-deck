import { randomUUID } from 'node:crypto';

import type {
  AgentCwdTransition,
  AgentCwdTransitionSwitchResult,
  AgentEnqueueOptions,
  GrokCreateOpts,
  PendingAgentMessage,
  QueuedAgentMessage,
} from '@main/adapters/types';
import { sessionManager } from '@main/session/manager';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import { sessionRepo } from '@main/store/session-repo';
import type {
  AdapterSessionMode,
  AgentEvent,
  PermissionRequest,
  PermissionResponse,
  ProviderUsageSnapshot,
  UploadedAttachmentRef,
} from '@shared/types';

import { GrokPermissionController } from './permission-controller';
import { errorText } from './protocol-utils';
import {
  createGrokRuntime,
  persistGrokModelOptions,
  persistGrokRuntimeMetadata,
  persistGrokSessionMode,
  recoverGrokRuntime,
} from './runtime-factory';
import type { GrokRuntime } from './runtime-types';
import type { GrokSessionSetupOptions } from './session-setup';
import { GrokTurnQueue } from './turn-queue';
import type { GrokEnqueueOptions } from './turn-queue-types';
import { recycleGrokTransport } from './transport-recovery';
import {
  startGrokRuntime,
  startGrokRuntimeInBackground,
  type GrokRuntimeStartContext,
} from './runtime-start';
import { readGrokUsageSnapshotInBackground } from './usage-snapshot';
import { probeGrokImageCapability } from './capability-probe';
import { GrokSandboxRestartController } from './sandbox-restart-controller';
import { GrokRuntimeLifecycleCoordinator } from './runtime-lifecycle-coordinator';
import { GrokMessageController } from './message-controller';
import { GrokRuntimeMutationController } from './runtime-mutation-controller';
import { GrokCwdTransitionController } from './cwd-transition-controller';

const AGENT_ID = 'grok-build';

export interface GrokBuildBridgeOptions extends GrokSessionSetupOptions {
  emit: (event: AgentEvent) => void;
  onNegotiatedImageCapability?: (supported: boolean) => void;
  permissionTimeoutMs: number;
  binaryPath?: string | null;
}

export class GrokBuildBridge {
  private readonly runtimes = new Map<string, GrokRuntime>();
  private readonly permissionController: GrokPermissionController;
  private readonly turnQueue: GrokTurnQueue;
  private readonly sandboxRestartController: GrokSandboxRestartController;
  private readonly lifecycle: GrokRuntimeLifecycleCoordinator;
  private readonly messageController: GrokMessageController;
  private readonly runtimeMutationController: GrokRuntimeMutationController;
  private readonly cwdTransitionController: GrokCwdTransitionController;
  private binaryPath: string | null;

  constructor(private readonly options: GrokBuildBridgeOptions) {
    this.binaryPath = options.binaryPath ?? null;
    this.permissionController = new GrokPermissionController(
      options.permissionTimeoutMs,
      (sessionId, kind, payload) => this.emit(sessionId, kind, payload),
    );
    this.turnQueue = new GrokTurnQueue({
      emit: options.emit,
      emitEvent: (sessionId, kind, payload) => this.emit(sessionId, kind, payload),
      emitError: (sessionId, text, failureReason) => this.emitError(sessionId, text, failureReason),
      closeSession: (sessionId) => this.closeSession(sessionId),
      recycleRuntime: (runtime) => recycleGrokTransport(runtime, {
        isCurrent: (candidate) => this.isCurrentRuntime(candidate),
        start: (candidate) => this.startRuntime(candidate),
        persist: persistGrokRuntimeMetadata,
        dispose: (candidate) => this.disposeRuntime(candidate),
        emitErrorMessage: (sessionId, text) =>
          this.emit(sessionId, 'message', {
            text: `⚠ ${text}`,
            role: 'assistant',
            error: true,
          }),
      }),
    });
    this.lifecycle = new GrokRuntimeLifecycleCoordinator(
      this.runtimes,
      this.permissionController,
      (runtime) => this.turnQueue.cancelSubmittingInterjection(runtime),
    );
    this.messageController = new GrokMessageController({
      emit: options.emit,
      dispatch: (sessionId, text, attachments, enqueueOptions, forceQueue) =>
        this.enqueueOrRecover(
          sessionId,
          text,
          attachments,
          enqueueOptions,
          forceQueue,
        ),
      steer: async (sessionId, text) => {
        const runtime = this.requireRuntime(sessionId);
        await this.turnQueue.steer(runtime, text);
      },
    });
    this.runtimeMutationController = new GrokRuntimeMutationController({
      getRuntime: (sessionId) => this.runtimes.get(sessionId) ?? null,
      getPersistedOptions: (sessionId) => {
        const record = sessionRepo.get(sessionId);
        if (!record || record.agentId !== AGENT_ID) return null;
        return {
          model: record.model ?? null,
          thinking: record.thinking ?? null,
          sessionMode: record.sessionMode ?? null,
        };
      },
      persistModelOptions: persistGrokModelOptions,
      persistSessionMode: (sessionId, mode) =>
        persistGrokSessionMode(sessionId, mode),
      dispose: (runtime) => this.disposeRuntime(runtime),
    });
    this.sandboxRestartController = new GrokSandboxRestartController({
      getRuntime: (sessionId) => this.runtimes.get(sessionId) ?? null,
      start: (runtime) => this.startRuntime(runtime),
      drain: (runtime) => this.turnQueue.drain(runtime),
      dispose: (runtime) => this.disposeRuntime(runtime),
      persist: persistGrokRuntimeMetadata,
    });
    this.cwdTransitionController = new GrokCwdTransitionController({
      getRuntime: (sessionId) => this.runtimes.get(sessionId) ?? null,
      start: (runtime) => this.startRuntime(runtime),
      dispose: (runtime) => this.disposeRuntime(runtime),
      drain: (runtime) => this.turnQueue.drain(runtime),
      cancelPermissions: (runtime) => this.permissionController.cancel(runtime),
      turnQueue: this.turnQueue,
    });
  }

  setBinaryPath(path: string | null): void {
    this.binaryPath = path;
  }

  setPermissionTimeoutMs(ms: number): void {
    this.permissionController.setTimeoutMs(ms);
  }

  getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    return readGrokUsageSnapshotInBackground({
      binaryPath: this.binaryPath,
    });
  }

  async probeCapabilities(cwd: string): Promise<boolean> {
    return probeGrokImageCapability(
      cwd,
      this.binaryPath,
      this.options.onNegotiatedImageCapability,
    );
  }

  async createSession(opts: GrokCreateOpts): Promise<string> {
    return this.createSessionInternal(opts);
  }

  async createTrustedContinuationSession(
    opts: GrokCreateOpts,
    turn: TrustedContinuationInitialTurn,
  ): Promise<string> {
    return this.createSessionInternal(opts, turn);
  }

  private async createSessionInternal(
    opts: GrokCreateOpts,
    trustedTurn?: TrustedContinuationInitialTurn,
  ): Promise<string> {
    const existing = opts.resume ? sessionRepo.get(opts.resume) : null;
    if (
      opts.resume &&
      (!existing || existing.agentId !== AGENT_ID || !existing.cliSessionId)
    ) {
      throw new Error(
        `Grok resume requires an existing Agent Deck Grok session with a native session id: ${opts.resume}`,
      );
    }
    const applicationSessionId = existing?.id ?? randomUUID();
    if (this.runtimes.has(applicationSessionId)) {
      throw new Error(`Grok session ${applicationSessionId} is already active.`);
    }

    this.emit(applicationSessionId, 'session-start', {
      cwd: opts.cwd,
      source: 'sdk',
      ...(opts.initialSessionRegistration
        ? { initialSpawnLink: opts.initialSessionRegistration.spawnLink }
        : {}),
      ...(opts.initialSessionRegistration?.hiddenFromHistory
        ? { initialHiddenFromHistory: true }
        : {}),
    });
    opts.initialSessionRegistration?.onRegistered(applicationSessionId);
    sessionManager.claimAsSdk(applicationSessionId);

    const runtime = createGrokRuntime(applicationSessionId, opts, existing);
    this.runtimes.set(applicationSessionId, runtime);

    try {
      persistGrokRuntimeMetadata(runtime);
      const waitForRuntime = existing !== null || opts.awaitCanonicalId === true;
      if (!waitForRuntime) {
        this.enqueueInitialTurn(runtime, opts, trustedTurn);
        setTimeout(() => {
          void this.startRuntimeInBackground(runtime);
        }, 0);
        return applicationSessionId;
      }

      if (!(await this.startRuntime(runtime))) {
        throw new Error(`Grok session ${applicationSessionId} closed before startup completed.`);
      }
      persistGrokRuntimeMetadata(runtime);
      this.enqueueInitialTurn(runtime, opts, trustedTurn);
      return applicationSessionId;
    } catch (error) {
      if (this.isCurrentRuntime(runtime) && !runtime.closed) {
        this.emitError(applicationSessionId, `Grok session startup failed: ${errorText(error)}`);
      }
      await this.disposeRuntime(runtime);
      throw error;
    }
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    enqueueOptions?: AgentEnqueueOptions,
  ): Promise<void> {
    await this.messageController.sendMessage(
      sessionId,
      text,
      attachments,
      enqueueOptions,
    );
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await this.messageController.enqueueMessage(
      sessionId,
      text,
      attachments,
      options,
    );
  }

  async steerTurn(sessionId: string, text: string): Promise<void> {
    await this.messageController.steerTurn(sessionId, text);
  }

  async interrupt(sessionId: string): Promise<void> { await this.lifecycle.interrupt(sessionId); }
  armCwdTransition(transition: AgentCwdTransition): void { this.cwdTransitionController.arm(transition); }

  async switchCwdForTransition(transition: AgentCwdTransition): Promise<AgentCwdTransitionSwitchResult> {
    await this.cwdTransitionController.switchCwd(transition);
    return { continuationAccepted: false };
  }

  async enqueueCwdTransitionContinuation(transition: AgentCwdTransition, text: string): Promise<void> { this.cwdTransitionController.enqueueContinuation(transition, text); }

  releaseCwdTransition(sessionId: string, generation: number): void { this.cwdTransitionController.release(sessionId, generation); }

  getRuntimeCwd(sessionId: string): string | null { return this.cwdTransitionController.runtimeCwd(sessionId); }

  async closeSession(sessionId: string): Promise<void> {
    await this.lifecycle.closeOrdinary(sessionId);
  }

  async closeSessionForRollback(sessionId: string): Promise<void> {
    await this.lifecycle.closeForRollback(sessionId);
  }

  retireSessionAfterCurrentTurn(sessionId: string): void {
    this.lifecycle.retireAfterCurrentTurn(sessionId);
  }

  snapshotQueuedMessagesForHandOff(sessionId: string): QueuedAgentMessage[] {
    return (this.runtimes.get(sessionId)?.queue ?? []).map((message) => ({
      text: message.text,
      ...(message.attachments?.length
        ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
    }));
  }

  listPendingOutgoingMessages(sessionId: string): PendingAgentMessage[] {
    const runtime = this.runtimes.get(sessionId);
    return runtime ? this.turnQueue.listPendingOutgoingMessages(runtime) : [];
  }

  async removePendingOutgoingMessage(
    sessionId: string,
    messageId: string,
  ): Promise<PendingAgentMessage | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return null;
    return this.turnQueue.removePendingOutgoingMessage(runtime, messageId);
  }

  respondPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): void {
    this.permissionController.respond(this.runtimes.get(sessionId), requestId, response);
  }

  listPending(sessionId: string): { permissions: PermissionRequest[] } {
    return { permissions: this.permissionController.list(this.runtimes.get(sessionId)) };
  }

  listAllPending(): Record<string, { permissions: PermissionRequest[] }> {
    return Object.fromEntries(
      [...this.runtimes.keys()].map((sessionId) => [sessionId, this.listPending(sessionId)]),
    );
  }

  async setSessionModelOptions(
    sessionId: string,
    options: { provider: string | null; model: string | null; thinking: string | null },
  ): Promise<void> {
    await this.runtimeMutationController.setModelOptions(sessionId, options);
  }

  async setSessionMode(
    sessionId: string,
    mode: AdapterSessionMode,
  ): Promise<void> {
    await this.runtimeMutationController.setSessionMode(sessionId, mode);
  }

  restartWithGrokSandbox(
    sessionId: string,
    sandbox: string | null,
  ): Promise<string> {
    return this.sandboxRestartController.restart(sessionId, sandbox);
  }

  async shutdown(): Promise<void> {
    await this.lifecycle.shutdownAll();
  }

  private async startRuntime(runtime: GrokRuntime): Promise<boolean> {
    return startGrokRuntime(runtime, this.runtimeStartContext());
  }

  private async enqueueOrRecover(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
    forceQueue = true,
  ): Promise<void> {
    let runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      const record = sessionRepo.get(sessionId);
      if (!record || record.agentId !== AGENT_ID || !record.cliSessionId) {
        throw new Error(`Grok session ${sessionId} is not available for recovery.`);
      }
      const recovered = recoverGrokRuntime(record);
      runtime = recovered;
      this.runtimes.set(sessionId, recovered);
      sessionManager.claimAsSdk(sessionId);
      try {
        if (!(await this.startRuntime(recovered))) {
          throw new Error(`Grok session ${sessionId} closed before recovery completed.`);
        }
        persistGrokRuntimeMetadata(recovered);
      } catch (error) {
        await this.disposeRuntime(recovered);
        throw error;
      }
    }
    if (forceQueue) {
      this.enqueue(runtime, text, attachments, options);
    } else {
      await this.turnQueue.send(runtime, text, attachments, options);
    }
  }

  private enqueue(
    runtime: GrokRuntime,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: GrokEnqueueOptions,
  ): void {
    this.turnQueue.enqueue(runtime, text, attachments, options);
  }

  private enqueueInitialTurn(
    runtime: GrokRuntime,
    opts: GrokCreateOpts,
    trustedTurn?: TrustedContinuationInitialTurn,
  ): void {
    if (!trustedTurn && opts.prompt === undefined && !opts.attachments?.length) return;
    this.enqueue(
      runtime,
      trustedTurn?.persistedUserText ?? opts.prompt ?? '',
      opts.attachments,
      {
        handOff: opts.handOff,
        ...(trustedTurn
          ? {
              providerText: trustedTurn.providerPrompt,
              continuation: trustedTurn.metadata,
            }
          : {}),
      },
    );
  }

  private async startRuntimeInBackground(runtime: GrokRuntime): Promise<void> {
    await startGrokRuntimeInBackground(
      runtime,
      this.runtimeStartContext(),
      persistGrokRuntimeMetadata,
    );
  }

  private runtimeStartContext(): GrokRuntimeStartContext {
    return {
      binaryPath: this.binaryPath,
      runtimes: this.runtimes,
      sessionSetup: this.options,
      permissionController: this.permissionController,
      emit: (event) => this.options.emit(event),
      emitError: (sessionId, text) => this.emitError(sessionId, text),
      isCurrentRuntime: (runtime) => this.isCurrentRuntime(runtime),
      requireNativeSession: (runtime) => this.requireNativeSession(runtime),
      onNegotiatedImageCapability: this.options.onNegotiatedImageCapability,
      confirmPromptAccepted: (runtime) => this.turnQueue.confirmPromptAccepted(runtime),
      observeModelActivity: (runtime, update) =>
        this.turnQueue.observeModelActivity(runtime, update),
      observePromptComplete: (runtime, notification) =>
        this.turnQueue.observePromptComplete(runtime, notification),
      drain: (runtime) => this.turnQueue.drain(runtime),
      dispose: (runtime) => this.disposeRuntime(runtime),
    };
  }

  private emitError(sessionId: string, text: string, failureReason?: 'context-window-exceeded'): void {
    this.emit(sessionId, 'message', { text: `⚠ ${text}`, role: 'assistant', error: true });
    this.emit(sessionId, 'finished', { ok: false, subtype: 'error', ...(failureReason ? { failureReason } : {}) });
  }

  private emit(sessionId: string, kind: AgentEvent['kind'], payload: unknown): void {
    this.options.emit({
      sessionId,
      agentId: AGENT_ID,
      kind,
      payload,
      ts: Date.now(),
      source: 'sdk',
    });
  }

  private async disposeRuntime(runtime: GrokRuntime): Promise<void> {
    await this.lifecycle.disposeOrdinary(runtime);
  }

  private isCurrentRuntime(runtime: GrokRuntime): boolean {
    return this.lifecycle.isCurrent(runtime);
  }

  private requireRuntime(sessionId: string): GrokRuntime {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.process || !runtime.ready || runtime.closed) {
      throw new Error(`Grok session ${sessionId} is not active.`);
    }
    return runtime;
  }

  private requireNativeSession(runtime: GrokRuntime): string {
    if (!runtime.nativeSessionId) {
      throw new Error(`Grok session ${runtime.applicationSessionId} has no native session id.`);
    }
    return runtime.nativeSessionId;
  }
}
