import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import log from '@main/utils/logger';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';
import { terminateRetiredCodexChild } from './process-recycle';
import type { CodexAppServerNotification } from './protocol';
import { logCodexThreadBoundaryReady } from './thread-boundary-logging';

const logger = log.scope('codex-app-server');
const DEFAULT_CONTROL_PLANE_DEADLINE_MS = 30_000;

export interface CodexGenerationOperation {
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export interface CodexGenerationLifecycleHost {
  isClosed(): boolean;
  getChild(): ChildProcessWithoutNullStreams | null;
  detachChild(child: ChildProcessWithoutNullStreams): boolean;
  requestRaw<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  requestForOperation<T = unknown>(
    method: string,
    params: unknown,
    operation: CodexGenerationOperation,
  ): Promise<T>;
  getSkillExtraRoots(): readonly string[] | undefined;
  abortServerRequests(): void;
  rejectPending(error: Error): void;
  dispatchNotification(notification: CodexAppServerNotification): void;
}

/**
 * Owns the bounded control-plane contract for one lazily-created app-server generation.
 *
 * The host retains process I/O and protocol parsing. This controller owns every state transition
 * that must happen atomically when readiness, a thread boundary, or disposal retires a generation.
 */
export class CodexGenerationController {
  private processGeneration = 0;
  private terminalDispatchGeneration: number | null = null;
  private initializePromise: Promise<void> | null = null;

  constructor(private readonly host: CodexGenerationLifecycleHost) {}

  get generation(): number {
    return this.processGeneration;
  }

  get hasCachedReadiness(): boolean {
    return this.initializePromise !== null;
  }

  acceptsNotificationForGeneration(generation: number): boolean {
    return generation === this.processGeneration || generation === this.terminalDispatchGeneration;
  }

  async run<T>(
    phase: string,
    callerSignal: AbortSignal | undefined,
    execute: (operation: CodexGenerationOperation) => Promise<T>,
  ): Promise<T> {
    if (this.host.isClosed()) throw new Error('Codex app-server client is closed');
    if (callerSignal?.aborted) throw controlPlaneAbortError(phase);

    const generation = this.processGeneration;
    const controller = new AbortController();
    let settled = false;
    let failure: Error | null = null;
    const fail = (error: Error): void => {
      if (settled || failure) return;
      failure = error;
      controller.abort();
      this.recycleControlPlaneGeneration(generation, error, phase);
    };
    const onCallerAbort = (): void => fail(controlPlaneAbortError(phase));
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const deadline = setTimeout(() => {
      fail(controlPlaneDeadlineError(phase, DEFAULT_CONTROL_PLANE_DEADLINE_MS));
    }, DEFAULT_CONTROL_PLANE_DEADLINE_MS);
    deadline.unref();

    const operation: CodexGenerationOperation = {
      generation,
      signal: controller.signal,
      isCurrent: () =>
        !controller.signal.aborted &&
        !this.host.isClosed() &&
        this.processGeneration === generation,
      request: <R = unknown>(method: string, params: unknown): Promise<R> =>
        this.host.requestForOperation<R>(method, params, operation),
    };

    try {
      const result = await execute(operation);
      if (failure) throw failure;
      this.assertOperationCurrent(operation, phase);
      settled = true;
      return result;
    } catch (error) {
      if (failure) throw failure;
      throw error;
    } finally {
      settled = true;
      clearTimeout(deadline);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async request<T>(
    method: string,
    params: unknown,
    operation: CodexGenerationOperation,
  ): Promise<T> {
    this.assertOperationCurrent(operation, method);
    await this.ensureReady(operation);
    this.assertOperationCurrent(operation, method);
    if (!isThreadBoundaryMethod(method)) {
      return this.host.requestRaw<T>(method, params, operation.signal);
    }

    const started = performance.now();
    const thread = readRequestThreadId(params);
    try {
      const response = await this.host.requestRaw<T>(method, params, operation.signal);
      logCodexThreadBoundaryReady({
        method,
        thread,
        durationMs: Math.round(performance.now() - started),
      });
      return response;
    } catch (error) {
      logger.warn(
        '[codex-app-server] thread boundary failed before readiness',
        safeDiagnostic({
          event: 'codex_app_server_thread_boundary',
          phase: method,
          outcome: 'failed',
          threadShort: thread.slice(0, 12),
          durationMs: Math.round(performance.now() - started),
          error: safeErrorSummary(error),
        }),
      );
      throw error;
    }
  }

  async ensureReady(operation: CodexGenerationOperation): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    const attempt = this.initialize(operation);
    this.initializePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.initializePromise === attempt) this.initializePromise = null;
      logger.warn(
        '[codex-app-server] initialize failed; next request will retry',
        safeDiagnostic({
          event: 'codex_app_server_initialize',
          phase: 'initialize',
          outcome: 'failed_retryable',
          processGeneration: this.processGeneration,
          error: safeErrorSummary(error),
        }),
      );
      throw error;
    }
  }

  retireCurrentProcess(
    exitedChild: ChildProcessWithoutNullStreams,
    error: Error,
  ): boolean {
    if (!this.host.detachChild(exitedChild)) return false;
    this.retireGeneration(error);
    return true;
  }

  recycleControlPlaneGeneration(
    expectedGeneration: number,
    error: Error,
    phase: string,
  ): boolean {
    if (this.host.isClosed() || this.processGeneration !== expectedGeneration) return false;
    const child = this.host.getChild();
    if (!child) {
      this.retireGeneration(error);
      this.logControlPlaneRecycle(phase, expectedGeneration, {
        sigtermSent: false,
        sigkillScheduled: false,
      });
      return true;
    }
    if (!this.retireCurrentProcess(child, error)) return false;
    const termination = terminateRetiredCodexChild(child, (signal) => {
      logger.warn(
        '[codex-app-server] control-plane recycle termination failed',
        safeDiagnostic({
          event: 'codex_app_server_control_plane_recycle_termination_failed',
          phase: boundedPhase(phase),
          expectedGeneration,
          actualGeneration: this.processGeneration,
          signal,
        }),
      );
    });
    this.logControlPlaneRecycle(phase, expectedGeneration, termination);
    return true;
  }

  dispose(error: Error): void {
    const child = this.host.getChild();
    if (!child) {
      this.clearReadiness(error);
      return;
    }
    if (!this.retireCurrentProcess(child, error)) {
      this.clearReadiness(error);
      return;
    }
    terminateRetiredCodexChild(child, (signal) => {
      logger.warn(
        '[codex-app-server] disposed child termination failed',
        safeDiagnostic({
          event: 'codex_app_server_dispose_termination_failed',
          processGeneration: this.processGeneration,
          signal,
        }),
      );
    });
  }

  private async initialize(operation: CodexGenerationOperation): Promise<void> {
    await this.host.requestRaw('initialize', {
      clientInfo: {
        name: 'agent-deck',
        title: 'Agent Deck',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }, operation.signal);
    const extraRoots = this.host.getSkillExtraRoots();
    if (!extraRoots || extraRoots.length === 0) return;
    try {
      await this.host.requestRaw('skills/extraRoots/set', {
        extraRoots,
      }, operation.signal);
    } catch (error) {
      if (!operation.isCurrent()) throw error;
      logger.warn(
        '[codex-app-server] skills/extraRoots/set failed',
        safeErrorSummary(error),
      );
    }
  }

  private assertOperationCurrent(
    operation: CodexGenerationOperation,
    phase: string,
  ): void {
    if (operation.signal.aborted) throw controlPlaneAbortError(phase);
    if (this.host.isClosed()) throw new Error('Codex app-server client is closed');
    if (operation.generation !== this.processGeneration) {
      throw new Error(`Codex app-server generation changed during ${phase}`);
    }
  }

  private retireGeneration(error: Error): void {
    this.initializePromise = null;
    this.host.abortServerRequests();
    this.host.rejectPending(error);
    const retiredGeneration = this.processGeneration;
    this.processGeneration += 1;
    this.terminalDispatchGeneration = retiredGeneration;
    try {
      this.host.dispatchNotification({
        method: 'error',
        params: {
          error: {
            message: error.message,
            codexErrorInfo: null,
            additionalDetails: null,
          },
          willRetry: false,
        },
      });
    } finally {
      this.terminalDispatchGeneration = null;
    }
  }

  private clearReadiness(error: Error): void {
    this.initializePromise = null;
    this.host.abortServerRequests();
    this.host.rejectPending(error);
  }

  private logControlPlaneRecycle(
    phase: string,
    expectedGeneration: number,
    termination: { sigtermSent: boolean; sigkillScheduled: boolean },
  ): void {
    logger.warn(
      '[codex-app-server] control-plane generation recycled',
      safeDiagnostic({
        event: 'codex_app_server_control_plane_recycle',
        phase: boundedPhase(phase),
        outcome: 'retired',
        expectedGeneration,
        actualGeneration: this.processGeneration,
        ...termination,
      }),
    );
  }
}

function isThreadBoundaryMethod(method: string): boolean {
  return method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork';
}

function readRequestThreadId(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'new';
  const threadId = (params as Record<string, unknown>).threadId;
  return typeof threadId === 'string' ? threadId : 'new';
}

function controlPlaneAbortError(phase: string): Error {
  return new Error(`Codex app-server ${boundedPhase(phase)} cancelled; retry starts a clean process`);
}

function controlPlaneDeadlineError(phase: string, timeoutMs: number): Error {
  return new Error(
    `Codex app-server ${boundedPhase(phase)} timed out after ${timeoutMs}ms; ` +
      'the unresponsive process was retired and the request can be retried',
  );
}

function boundedPhase(phase: string): string {
  return phase.trim().replace(/[^a-zA-Z0-9_./:-]+/g, '_').slice(0, 96) || 'request';
}
