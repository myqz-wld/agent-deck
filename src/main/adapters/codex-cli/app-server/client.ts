import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import { formatRpcError } from './notification-helpers';
import type { CodexMcpStartupObserver } from './mcp-startup-observer';
import { DEFAULT_FIRST_MODEL_EVENT_TIMEOUT_MS } from './first-model-event-watchdog';
import {
  sanitizeCodexStderrTail,
  type CodexProcessDiagnosticSnapshot,
} from './turn-watchdog-diagnostics';
import { terminateRetiredCodexChild } from './process-recycle';
import {
  invokeCodexClientDiagnostic,
} from './client-diagnostics-port';
import {
  UNCONFIGURED_CODEX_CLIENT_HOST,
  type CodexAppServerClientHost,
} from './client-host-port';
import type {
  CodexAppServerNotification,
  CodexAppServerOptions,
  CodexAppServerServerRequestHandler,
  CodexAppServerThreadCreateResult,
  CodexAppServerThreadReadResult,
  JsonValue,
  JsonRpcResponse,
} from './protocol';
import {
  buildThreadForkParams,
  buildThreadConfig,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
} from './thread-params';
import type { CodexAppServerThread } from './thread';
import { requestCodexRaw, type CodexPendingRequest } from './request-raw';
import { CodexServerRequestHost } from './server-request-host';
import { CodexGenerationController, type CodexGenerationOperation } from './generation-operation';

export type {
  CodexAppServerNotification,
  CodexAppServerOptions,
  CodexAppServerRunResult,
  CodexAppServerStreamEvent,
  CodexAppServerUserInput,
} from './protocol';
export { CodexAppServerThread } from './thread';
export type { CodexGenerationOperation } from './generation-operation';
type Unsubscribe = () => void;

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, CodexPendingRequest>();
  private notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly serverRequestHost = new CodexServerRequestHost(() => this.child);
  private closed = false;
  private currentStderrTail = '';
  private readonly mcpStartupObserver: CodexMcpStartupObserver;
  private readonly generationController: CodexGenerationController;

  constructor(
    private readonly opts: CodexAppServerOptions,
    private readonly host: CodexAppServerClientHost = UNCONFIGURED_CODEX_CLIENT_HOST,
  ) {
    this.mcpStartupObserver = this.host.createMcpStartupObserver();
    this.generationController = new CodexGenerationController({
      isClosed: () => this.closed,
      getChild: () => this.child,
      detachChild: (child) => this.detachChild(child),
      requestRaw: <T>(method: string, params: unknown, signal?: AbortSignal) =>
        this.requestRaw<T>(method, params, signal),
      requestForOperation: <T>(
        method: string,
        params: unknown,
        operation: CodexGenerationOperation,
      ) => this.request !== CodexAppServerClient.prototype.request
        ? this.request<T>(method, params, operation.signal)
        : this.generationController.request<T>(method, params, operation),
      getSkillExtraRoots: () => this.opts.skillExtraRoots,
      abortServerRequests: () => this.serverRequestHost.abortAll(),
      rejectPending: (error) => this.rejectAll(error),
      dispatchNotification: (notification) => this.dispatchNotification(notification),
    }, this.host.generationDiagnostics);
  }

  get baseConfig(): CodexConfigObject | null { return this.opts.config ?? null; }
  get generation(): number { return this.generationController.generation; }
  /** True only for the live generation or its synchronous synthetic retirement terminal. */
  acceptsNotificationForGeneration(generation: number): boolean {
    return this.generationController.acceptsNotificationForGeneration(generation);
  }

  get firstModelEventTimeoutMs(): number {
    const configured = this.opts.firstModelEventTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? Math.max(1, Math.trunc(configured))
      : DEFAULT_FIRST_MODEL_EVENT_TIMEOUT_MS;
  }

  getProcessDiagnosticSnapshot(): CodexProcessDiagnosticSnapshot {
    return {
      processGeneration: this.generation,
      processPid: this.child?.pid ?? null,
      processAlive: this.child !== null,
      pendingRpcCount: this.pending.size,
      stderrTailBytes: Buffer.byteLength(this.currentStderrTail, 'utf8'),
      hasStderrTail: this.currentStderrTail.length > 0,
    };
  }

  /**
   * 子进程当前是否存活。Thread.interrupt 用：进程已退出时 turn 早已被 handleExit 的
   * synthetic error 通知终结，此时再走 request('turn/interrupt') 会经 ensureProcess
   * **重新拉起一个全新 app-server 进程**只为发一条无意义的 interrupt —— 该 guard 避免之。
   */
  get isProcessAlive(): boolean { return this.child !== null; }

  /** True after dispose(); used by fork rollback to reopen a target-owned cleanup client. */
  get isDisposed(): boolean { return this.closed; }

  /**
   * Create an unmapped client with the same target-owned config and environment. Fork rollback
   * uses this only when the registered child client was already disposed by the normal close path.
   */
  createSiblingClient(): CodexAppServerClient {
    return new CodexAppServerClient({
      ...this.opts,
      env: { ...this.opts.env },
      ...(this.opts.skillExtraRoots ? { skillExtraRoots: [...this.opts.skillExtraRoots] } : {}),
    }, this.host);
  }

  startThread(options: CodexThreadOptions): CodexAppServerThread {
    return this.host.createThread(this, { mode: 'start', options });
  }
  resumeThread(threadId: string, options: CodexThreadOptions): CodexAppServerThread {
    return this.host.createThread(this, { mode: 'resume', threadId, options });
  }
  adoptThread(
    threadId: string,
    options: CodexThreadOptions,
    initialRuntime?: Pick<CodexAppServerThreadCreateResult, 'model' | 'modelProvider'>,
  ): CodexAppServerThread {
    return this.host.createThread(this, { mode: 'resume', threadId, options },
      this.isProcessAlive ? this.generation : undefined, initialRuntime);
  }
  prepareThreadOptions(
    options: CodexThreadOptions,
    operation?: CodexGenerationOperation,
  ): Promise<CodexThreadOptions> {
    return this.opts.nodeReplBrowserBootstrap
      ? this.host.prepareThreadOptions(this, options, this.baseConfig, operation)
      : Promise.resolve(options);
  }
  readThread(threadId: string): Promise<CodexAppServerThreadReadResult> {
    return this.request('thread/read', { threadId, includeTurns: true });
  }
  startThreadEager(
    options: CodexThreadOptions,
    signal?: AbortSignal,
  ): Promise<CodexAppServerThreadCreateResult> {
    return this.runGenerationOperation('thread/start readiness', signal, async (operation) => {
      const prepared = await this.prepareThreadOptions(options, operation);
      return operation.request(
        'thread/start',
        buildThreadStartParams(prepared, this.baseConfig),
      );
    });
  }
  forkThread(
    sourceThreadId: string,
    lastTurnId: string,
    options: CodexThreadOptions,
    signal?: AbortSignal,
  ): Promise<CodexAppServerThreadCreateResult> {
    return this.runGenerationOperation('thread/fork readiness', signal, async (operation) => {
      const prepared = await this.prepareThreadOptions(options, operation);
      return operation.request(
        'thread/fork',
        buildThreadForkParams(sourceThreadId, lastTurnId, prepared, this.baseConfig),
      );
    });
  }

  injectThreadItems(threadId: string, items: JsonValue[]): Promise<void> {
    return this.request('thread/inject_items', { threadId, items });
  }
  deleteThread(threadId: string): Promise<void> { return this.request('thread/delete', { threadId }); }

  async request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.runGenerationOperation(method, signal, (operation) =>
      operation.request<T>(method, params));
  }

  /**
   * Run one control-plane operation against exactly one process generation.
   *
   * The deadline and caller abort are wired into the underlying JSON-RPC requests. Either failure
   * retires the whole generation, so shared initialize/readiness waiters reject together and no
   * request can survive behind an outer Promise.race.
   */
  async runGenerationOperation<T>(
    phase: string,
    callerSignal: AbortSignal | undefined,
    execute: (operation: CodexGenerationOperation) => Promise<T>,
  ): Promise<T> {
    return this.generationController.run(phase, callerSignal, execute);
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  hasExclusiveNotificationSubscriber(): boolean { return this.notificationListeners.size === 1; }
  /**
   * Install the host callback for app-server initiated requests. Codex uses these requests for
   * native command, file-change, and expanded permission approvals.
   */
  setServerRequestHandler(handler: CodexAppServerServerRequestHandler | null): void {
    this.serverRequestHost.setHandler(handler);
  }

  /** Write one provider-native interrupt without starting or awaiting a new process. */
  sendTurnInterrupt(
    expectedGeneration: number,
    threadId: string,
    turnId: string,
  ): boolean {
    if (this.closed || this.generation !== expectedGeneration || !this.child) return false;
    return this.writeTurnInterrupt(this.child, threadId, turnId) === 'sent';
  }

  /** Fence an unacknowledged accepted turn after its one interrupt has already been written. */
  recycleGeneration(
    expectedGeneration: number,
    error: Error,
    phase: string,
  ): boolean {
    return this.generationController.recycleControlPlaneGeneration(
      expectedGeneration,
      error,
      phase,
    );
  }

  /**
   * Best-effort interrupt followed by a fenced process recycle.
   *
   * The interrupt is written only to the currently-owned child and is intentionally not awaited:
   * a silent app-server cannot be trusted to answer it. Detaching first makes pending RPC cleanup
   * synchronous, increments the generation before another process can start, and fences every
   * late stdout/exit callback from the retired child.
   */
  abortTurnAndRecycleGeneration(
    expectedGeneration: number,
    threadId: string,
    turnId: string,
    err: Error,
  ): boolean {
    const before = this.getProcessDiagnosticSnapshot();
    const recycleContext = { threadId, turnId, expectedGeneration, before };
    if (this.closed || this.generation !== expectedGeneration) {
      this.diagnose(() => this.host.recycleSkipped(
        recycleContext,
        'generation_mismatch',
      ));
      return false;
    }
    const child = this.child;
    if (!child) {
      this.diagnose(() => this.host.recycleSkipped(recycleContext, 'process_missing'));
      return false;
    }

    const interruptWrite = this.writeTurnInterrupt(child, threadId, turnId);

    // Recycling is process-wide. Emit a process-level terminal (no turn/thread filter) so any
    // other accepted turns sharing this generation also close instead of waiting on dead queues.
    if (!this.generationController.retireCurrentProcess(child, err)) {
      this.diagnose(() => this.host.recycleDetachFailed(
        recycleContext,
        this.getProcessDiagnosticSnapshot(),
        interruptWrite,
      ));
      return false;
    }
    const termination = terminateRetiredCodexChild(child, (signal) => {
      this.diagnose(() => this.host.recycleTerminationFailed(recycleContext, signal));
    });
    const after = this.getProcessDiagnosticSnapshot();
    this.diagnose(() => this.host.recycleCompleted(
      recycleContext,
      after,
      interruptWrite,
      termination,
    ));
    return true;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.generationController.dispose(new Error('Codex app-server disposed'));
    this.notificationListeners.clear();
  }

  private writeTurnInterrupt(
    child: ChildProcessWithoutNullStreams,
    threadId: string,
    turnId: string,
  ): 'sent' | 'failed' {
    try {
      const id = this.nextId++;
      child.stdin.write(`${JSON.stringify({
        method: 'turn/interrupt',
        id,
        params: { threadId, turnId },
      })}\n`);
      return 'sent';
    } catch (interruptError) {
      this.diagnose(() => this.host.interruptWriteFailed({
        errorName: interruptError instanceof Error ? interruptError.name : 'unknown',
        errorCode: readErrorCode(interruptError),
      }));
      return 'failed';
    }
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) throw new Error('Codex app-server client is closed');

    const child = this.host.startProcess({
      codexPathOverride: this.opts.codexPathOverride,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      env: this.opts.env,
    });
    this.child = child;
    this.currentStderrTail = '';
    let lastStderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.child !== child) return;
      lastStderr = `${lastStderr}${chunk}`.slice(-8000);
      this.currentStderrTail = lastStderr;
      const safeTail = sanitizeCodexStderrTail(chunk);
      this.diagnose(() => this.host.stderrActivity({
        processGeneration: this.generation,
        processPid: child.pid ?? null,
        bytes: Buffer.byteLength(chunk, 'utf8'),
        sanitizedTail: safeTail,
        contentOmitted: safeTail === null,
      }));
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(child, line));
    child.on('error', (err) => this.handleExit(child, err));
    child.on('exit', (code, signal) => {
      const stderrBytes = Buffer.byteLength(lastStderr, 'utf8');
      const suffix = stderrBytes > 0 ? ` stderrBytes=${stderrBytes}` : '';
      this.handleExit(
        child,
        new Error(`Codex app-server exited code=${code} signal=${signal}${suffix}`),
      );
    });

    return child;
  }

  private requestRaw<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    return requestCodexRaw({ child, pending: this.pending, id, method, params, signal });
  }

  private handleLine(sourceChild: ChildProcessWithoutNullStreams, raw: string): void {
    // A watchdog recycle detaches the old process before SIGTERM/SIGKILL completes. Its buffered
    // stdout may still emit lines; never let those cross the generation boundary.
    if (this.child !== sourceChild) return;
    const line = raw.trim();
    if (!line) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.diagnose(() => this.host.stdoutParseFailed({
        processGeneration: this.generation,
        processPid: sourceChild.pid ?? null,
        bytes: Buffer.byteLength(line, 'utf8'),
        errorName: err instanceof Error ? err.name : 'unknown',
      }));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;

    if ('id' in obj && (Object.prototype.hasOwnProperty.call(obj, 'result') || 'error' in obj)) {
      this.handleResponse(obj as unknown as JsonRpcResponse);
      return;
    }

    if (
      typeof obj.method === 'string' &&
      (typeof obj.id === 'number' || typeof obj.id === 'string')
    ) {
      void this.serverRequestHost.handle(sourceChild, {
        id: obj.id,
        method: obj.method,
        params: obj.params,
      });
      return;
    }

    if (typeof obj.method === 'string') {
      this.dispatchNotification({ method: obj.method, params: obj.params });
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(formatRpcError(response.error)));
      return;
    }
    pending.resolve(response.result);
  }

  private dispatchNotification(notification: CodexAppServerNotification): void {
    this.serverRequestHost.observe(notification);
    const mcpStartup = this.mcpStartupObserver.observe(notification);
    if (mcpStartup) this.diagnose(() => this.host.mcpStartupObserved(mcpStartup));
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(notification);
      } catch (err) {
        this.diagnose(() => this.host.notificationListenerFailed(err));
      }
    }
  }

  private handleExit(exitedChild: ChildProcessWithoutNullStreams, err: Error): void {
    // `error` is normally followed by `exit`; an old child's late exit may also arrive after a
    // replacement process was spawned. Only the currently-owned child may clear state/reject RPCs.
    this.generationController.retireCurrentProcess(exitedChild, err);
  }

  private detachChild(
    exitedChild: ChildProcessWithoutNullStreams,
  ): boolean {
    if (this.child !== exitedChild) return false;
    this.child = null;
    this.currentStderrTail = '';
    this.mcpStartupObserver.reset();
    return true;
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private diagnose(observe: () => void): void {
    invokeCodexClientDiagnostic(observe);
  }
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 64) : null;
}

export const __testables = {
  buildThreadStartParams,
  buildThreadResumeParams,
  buildThreadForkParams,
  buildTurnStartParams,
  buildThreadConfig,
};
