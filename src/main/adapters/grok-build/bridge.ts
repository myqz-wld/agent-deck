import { randomUUID } from 'node:crypto';

import { methods } from '@agentclientprotocol/sdk';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type {
  AgentEnqueueOptions,
  GrokCreateOpts,
  PendingAgentMessage,
  QueuedAgentMessage,
} from '@main/adapters/types';
import { bufferHandOffSourceInput } from '@main/session/hand-off/input-buffer';
import { sessionManager } from '@main/session/manager';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import { sessionRepo } from '@main/store/session-repo';
import type {
  AdapterSessionMode,
  AgentEvent,
  PermissionRequest,
  PermissionResponse,
  UploadedAttachmentRef,
} from '@shared/types';

import { GrokAcpProcess, withTimeout } from './acp-process';
import { GrokPermissionController } from './permission-controller';
import { currentModelId, currentSessionMode, errorText } from './protocol-utils';
import { resolveGrokBinary } from './resolve-grok-binary';
import {
  createGrokRuntime,
  persistGrokRuntimeMetadata,
  recoverGrokRuntime,
} from './runtime-factory';
import type { GrokRuntime } from './runtime-types';
import { buildGrokMcpServers, buildGrokSessionMeta } from './session-setup';
import { GrokTurnQueue, type GrokEnqueueOptions } from './turn-queue';
import { translateGrokUpdate } from './translate';

const AGENT_ID = 'grok-build';
const REQUEST_TIMEOUT_MS = 15_000;

export interface GrokBuildBridgeOptions {
  emit: (event: AgentEvent) => void;
  mcpHttpUrl: string;
  isAgentDeckMcpEnabled: () => boolean;
  getAgentProfilePrompt: () => Promise<string | null>;
  getPluginDirectories: (options: { requiresAgent: boolean }) => Promise<string[]>;
  onNegotiatedImageCapability?: (supported: boolean) => void;
  permissionTimeoutMs: number;
  binaryPath?: string | null;
}

export class GrokBuildBridge {
  private readonly runtimes = new Map<string, GrokRuntime>();
  private readonly permissionController: GrokPermissionController;
  private readonly turnQueue: GrokTurnQueue;
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
      emitError: (sessionId, text) => this.emitError(sessionId, text),
      closeSession: (sessionId) => this.closeSession(sessionId),
    });
  }

  setBinaryPath(path: string | null): void {
    this.binaryPath = path;
  }

  setPermissionTimeoutMs(ms: number): void {
    this.permissionController.setTimeoutMs(ms);
  }

  async probeCapabilities(cwd: string): Promise<boolean> {
    const binary = await resolveGrokBinary(this.binaryPath);
    const process = await GrokAcpProcess.start({
      binary,
      cwd,
      onSessionUpdate: () => undefined,
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    try {
      const image =
        process.initializeResponse.agentCapabilities?.promptCapabilities?.image === true;
      this.options.onNegotiatedImageCapability?.(image);
      return image;
    } finally {
      await process.stop();
    }
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
      await this.startRuntime(runtime);
      persistGrokRuntimeMetadata(runtime);
      if (trustedTurn || opts.prompt !== undefined || opts.attachments?.length) {
        await this.enqueue(
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
      return applicationSessionId;
    } catch (error) {
      this.emitError(applicationSessionId, `Grok session startup failed: ${errorText(error)}`);
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
    if (
      bufferHandOffSourceInput({
        sourceSessionId: sessionId,
        agentId: AGENT_ID,
        text,
        attachments,
        emit: this.options.emit,
        replay: (sourceSessionId) =>
          this.enqueueOrRecover(sourceSessionId, text, attachments, enqueueOptions),
      })
    ) {
      return;
    }
    await this.enqueueOrRecover(sessionId, text, attachments, enqueueOptions);
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await this.enqueueOrRecover(sessionId, text, attachments, options);
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.process || !runtime.nativeSessionId) return;
    await runtime.process.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: runtime.nativeSessionId,
    });
    this.permissionController.cancel(runtime);
  }

  async closeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      mcpSessionTokenMap.release(sessionId);
      sessionManager.releaseSdkClaim(sessionId);
      return;
    }
    runtime.closed = true;
    runtime.sealed = true;
    runtime.queue.length = 0;
    await this.disposeRuntime(runtime);
  }

  retireSessionAfterCurrentTurn(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.sealed = true;
    runtime.queue.length = 0;
    if (!runtime.running) void this.closeSession(sessionId);
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
    return (this.runtimes.get(sessionId)?.queue ?? []).map((message) => ({
      id: message.id,
      text: message.text,
      ...(message.attachments?.length
        ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
    }));
  }

  removePendingOutgoingMessage(
    sessionId: string,
    messageId: string,
  ): PendingAgentMessage | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return null;
    const index = runtime.queue.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const [removed] = runtime.queue.splice(index, 1);
    return removed ?? null;
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
    options: { model: string | null; thinking: string | null },
  ): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    const targetModel = options.model ?? runtime.model;
    const targetThinking = options.thinking ?? runtime.thinking;
    if (targetModel === runtime.model && targetThinking === runtime.thinking) return;
    if (!targetModel) {
      throw new Error(
        'Grok ACP requires a concrete model before changing model or reasoning effort.',
      );
    }

    await runtime.process!.connection.agent.request<
      Record<string, never>,
      {
        sessionId: string;
        modelId: string;
        _meta?: { reasoningEffort: string };
      }
    >('session/set_model', {
      sessionId: this.requireNativeSession(runtime),
      modelId: targetModel,
      ...(targetThinking
        ? { _meta: { reasoningEffort: targetThinking } }
        : {}),
    });
    runtime.model = targetModel;
    runtime.thinking = targetThinking;
    sessionRepo.setModel(sessionId, targetModel);
    if (targetThinking) sessionRepo.setThinking(sessionId, targetThinking);
  }

  async setSessionMode(
    sessionId: string,
    mode: AdapterSessionMode,
  ): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    await runtime.process!.connection.agent.request(methods.agent.session.setMode, {
      sessionId: this.requireNativeSession(runtime),
      modeId: mode,
    });
    runtime.sessionMode = mode;
    sessionRepo.setSessionMode(sessionId, mode);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.runtimes.values()].map((runtime) => this.disposeRuntime(runtime)),
    );
  }

  private async startRuntime(runtime: GrokRuntime): Promise<void> {
    const requestedMode = runtime.sessionMode;
    let reportedMode: AdapterSessionMode | null = null;
    const binary = await resolveGrokBinary(this.binaryPath);
    const process = await GrokAcpProcess.start({
      binary,
      cwd: runtime.cwd,
      onSessionUpdate: (notification) => {
        if (
          runtime.suppressUpdates ||
          notification.sessionId !== runtime.nativeSessionId
        ) return;
        for (const event of translateGrokUpdate(
          runtime.applicationSessionId,
          runtime.cwd,
          notification.update,
          runtime.translation,
        )) {
          this.options.emit(event);
        }
      },
      onPermissionRequest: (request, signal) =>
        this.permissionController.handle(runtime, request, signal),
    });
    runtime.process = process;
    process.onExit((code, signal) => {
      if (process.isStopping || runtime.closed) return;
      const diagnostics = process.diagnostics;
      this.emitError(
        runtime.applicationSessionId,
        `Grok ACP exited unexpectedly (${signal ?? code ?? 'unknown'}).${
          diagnostics ? `\n${diagnostics}` : ''
        }`,
      );
      void this.disposeRuntime(runtime);
    });
    this.options.onNegotiatedImageCapability?.(
      process.initializeResponse.agentCapabilities?.promptCapabilities?.image === true,
    );

    const mcpServers = buildGrokMcpServers(runtime.applicationSessionId, this.options);
    const meta = await buildGrokSessionMeta(runtime, this.options);
    if (runtime.nativeSessionId) {
      if (!process.initializeResponse.agentCapabilities?.loadSession) {
        throw new Error('This Grok ACP version cannot load existing sessions.');
      }
      const response = await withTimeout(
        process.connection.agent.request(methods.agent.session.load, {
          sessionId: runtime.nativeSessionId,
          cwd: runtime.cwd,
          mcpServers,
          _meta: meta,
        }),
        REQUEST_TIMEOUT_MS,
        'Grok ACP session/load',
      );
      runtime.model ??=
        currentModelId(response) ?? currentModelId(process.initializeResponse);
      reportedMode = currentSessionMode(response);
      runtime.sessionMode ??= reportedMode;
      runtime.suppressUpdates = false;
    } else {
      const response = await withTimeout(
        process.connection.agent.request(methods.agent.session.new, {
          cwd: runtime.cwd,
          mcpServers,
          _meta: meta,
        }),
        REQUEST_TIMEOUT_MS,
        'Grok ACP session/new',
      );
      runtime.nativeSessionId = response.sessionId;
      runtime.model ??=
        currentModelId(response) ?? currentModelId(process.initializeResponse);
      reportedMode = currentSessionMode(response) ?? 'default';
      runtime.sessionMode ??= reportedMode;
      sessionManager.updateCliSessionId(
        runtime.applicationSessionId,
        response.sessionId,
      );
    }
    if (requestedMode && requestedMode !== reportedMode) {
      await process.connection.agent.request(methods.agent.session.setMode, {
        sessionId: this.requireNativeSession(runtime),
        modeId: requestedMode,
      });
      runtime.sessionMode = requestedMode;
    }

  }

  private async enqueueOrRecover(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
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
        await this.startRuntime(recovered);
        persistGrokRuntimeMetadata(recovered);
      } catch (error) {
        await this.disposeRuntime(recovered);
        throw error;
      }
    }
    await this.enqueue(runtime, text, attachments, options);
  }

  private async enqueue(
    runtime: GrokRuntime,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: GrokEnqueueOptions,
  ): Promise<void> {
    this.turnQueue.enqueue(runtime, text, attachments, options);
  }

  private emitError(sessionId: string, text: string): void {
    this.emit(sessionId, 'message', { text: `⚠ ${text}`, role: 'assistant', error: true });
    this.emit(sessionId, 'finished', { ok: false, subtype: 'error' });
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
    if (runtime.closed && !this.runtimes.has(runtime.applicationSessionId)) return;
    runtime.closed = true;
    this.permissionController.cancel(runtime);
    this.runtimes.delete(runtime.applicationSessionId);
    mcpSessionTokenMap.release(runtime.applicationSessionId);
    sessionManager.releaseSdkClaim(runtime.applicationSessionId);
    if (runtime.process) await runtime.process.stop();
  }

  private requireRuntime(sessionId: string): GrokRuntime {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.process || runtime.closed) {
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
