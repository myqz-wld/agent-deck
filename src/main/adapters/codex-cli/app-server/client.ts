import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import {
  prependResolvedCodexPathDirs,
  resolveCodexBinary,
} from '../sdk-bridge/codex-binary';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import { formatRpcError } from './notification-helpers';
import {
  AgentDeckMcpStartupObserver,
  sanitizeMcpDiagnostic,
} from './mcp-startup-observer';
import { DEFAULT_FIRST_MODEL_EVENT_TIMEOUT_MS } from './first-model-event-watchdog';
import {
  sanitizeCodexStderrTail,
  type CodexProcessDiagnosticSnapshot,
} from './turn-watchdog-diagnostics';
import { terminateRetiredCodexChild } from './process-recycle';
import {
  logCodexRecycleCompleted,
  logCodexRecycleDetachFailure,
  logCodexRecycleSkipped,
  logCodexTerminationFailure,
} from './recycle-logging';
import type {
  CodexAppServerNotification,
  CodexAppServerOptions,
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
import { CodexAppServerThread } from './thread';
import { logCodexThreadBoundaryReady } from './thread-boundary-logging';
import { prepareNodeReplCompatibility } from './node-repl-compat';
import log from '@main/utils/logger';

const logger = log.scope('codex-app-server');

export type {
  CodexAppServerNotification,
  CodexAppServerOptions,
  CodexAppServerRunResult,
  CodexAppServerStreamEvent,
  CodexAppServerUserInput,
} from './protocol';
export { CodexAppServerThread } from './thread';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type Unsubscribe = () => void;

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  private initializePromise: Promise<void> | null = null;
  private closed = false;
  private processGeneration = 0;
  private currentStderrTail = '';
  private readonly mcpStartupObserver = new AgentDeckMcpStartupObserver();

  constructor(private readonly opts: CodexAppServerOptions) {}

  get baseConfig(): CodexConfigObject | null { return this.opts.config ?? null; }

  get generation(): number { return this.processGeneration; }

  get firstModelEventTimeoutMs(): number {
    const configured = this.opts.firstModelEventTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? Math.max(1, Math.trunc(configured))
      : DEFAULT_FIRST_MODEL_EVENT_TIMEOUT_MS;
  }

  getProcessDiagnosticSnapshot(): CodexProcessDiagnosticSnapshot {
    return {
      processGeneration: this.processGeneration,
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
      ...(this.opts.skillExtraRoots
        ? { skillExtraRoots: [...this.opts.skillExtraRoots] }
        : {}),
    });
  }

  startThread(options: CodexThreadOptions): CodexAppServerThread {
    return new CodexAppServerThread(this, { mode: 'start', options });
  }
  resumeThread(threadId: string, options: CodexThreadOptions): CodexAppServerThread {
    return new CodexAppServerThread(this, { mode: 'resume', threadId, options });
  }
  adoptThread(threadId: string, options: CodexThreadOptions): CodexAppServerThread {
    return new CodexAppServerThread(
      this,
      { mode: 'resume', threadId, options },
      this.isProcessAlive ? this.generation : undefined,
    );
  }
  prepareThreadOptions(options: CodexThreadOptions): Promise<CodexThreadOptions> {
    return this.opts.nodeReplSandboxMetaCompatibility
      ? prepareNodeReplCompatibility(this, options, this.baseConfig)
      : Promise.resolve(options);
  }
  readThread(threadId: string): Promise<CodexAppServerThreadReadResult> {
    return this.request('thread/read', { threadId, includeTurns: true });
  }
  async startThreadEager(options: CodexThreadOptions): Promise<CodexAppServerThreadCreateResult> {
    options = await this.prepareThreadOptions(options);
    return this.request('thread/start', buildThreadStartParams(options, this.baseConfig));
  }
  async forkThread(sourceThreadId: string, lastTurnId: string, options: CodexThreadOptions): Promise<CodexAppServerThreadCreateResult> {
    options = await this.prepareThreadOptions(options);
    return this.request(
      'thread/fork',
      buildThreadForkParams(sourceThreadId, lastTurnId, options, this.baseConfig),
    );
  }

  injectThreadItems(threadId: string, items: JsonValue[]): Promise<void> {
    return this.request('thread/inject_items', { threadId, items });
  }
  deleteThread(threadId: string): Promise<void> { return this.request('thread/delete', { threadId }); }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureInitialized();
    if (!isThreadBoundaryMethod(method)) return this.requestRaw<T>(method, params);
    const started = performance.now();
    const thread = readRequestThreadId(params);
    try {
      const response = await this.requestRaw<T>(method, params);
      const durationMs = Math.round(performance.now() - started);
      logCodexThreadBoundaryReady({ method, thread, durationMs });
      return response;
    } catch (err) {
      const diagnostic = sanitizeMcpDiagnostic(err) ?? 'unknown error';
      logger.warn(
        `[codex-app-server] ${method} failed before thread readiness ` +
          `(thread=${thread}, durationMs=${Math.round(performance.now() - started)}, ` +
          `error=${diagnostic})`,
      );
      throw err;
    }
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
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
    if (this.closed || this.processGeneration !== expectedGeneration) {
      logCodexRecycleSkipped(logger, recycleContext, 'generation_mismatch');
      return false;
    }
    const child = this.child;
    if (!child) {
      logCodexRecycleSkipped(logger, recycleContext, 'process_missing');
      return false;
    }

    let interruptWrite: 'sent' | 'failed' = 'sent';
    try {
      const id = this.nextId++;
      child.stdin.write(`${JSON.stringify({
        method: 'turn/interrupt',
        id,
        params: { threadId, turnId },
      })}\n`);
    } catch (interruptErr) {
      interruptWrite = 'failed';
      logger.debug('[codex-app-server] watchdog interrupt write failed', {
        event: 'codex_turn_watchdog_interrupt_write_failed',
        errorName: interruptErr instanceof Error ? interruptErr.name : 'unknown',
        errorCode: readErrorCode(interruptErr),
      });
    }

    // Recycling is process-wide. Emit a process-level terminal (no turn/thread filter) so any
    // other accepted turns sharing this generation also close instead of waiting on dead queues.
    if (!this.retireCurrentProcess(child, err)) {
      logCodexRecycleDetachFailure(
        logger,
        recycleContext,
        this.getProcessDiagnosticSnapshot(),
        interruptWrite,
      );
      return false;
    }
    const termination = terminateRetiredCodexChild(child, (signal) => {
      logCodexTerminationFailure(logger, recycleContext, signal);
    });
    const after = this.getProcessDiagnosticSnapshot();
    logCodexRecycleCompleted(logger, recycleContext, after, interruptWrite, termination);
    return true;
  }

  dispose(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.currentStderrTail = '';
    if (child && !child.killed) {
      child.kill();
    }
    this.rejectAll(new Error('Codex app-server disposed'));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    const attempt = (async () => {
      await this.requestRaw('initialize', {
        clientInfo: {
          name: 'agent-deck',
          title: 'Agent Deck',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      if (this.opts.skillExtraRoots && this.opts.skillExtraRoots.length > 0) {
        try {
          await this.requestRaw('skills/extraRoots/set', {
            extraRoots: this.opts.skillExtraRoots,
          });
        } catch (err) {
          logger.warn('[codex-app-server] skills/extraRoots/set failed', err);
        }
      }
    })();
    this.initializePromise = attempt;
    try {
      await attempt;
    } catch (err) {
      if (this.initializePromise === attempt) this.initializePromise = null;
      logger.warn(
        '[codex-app-server] initialize failed; next request will retry ' +
          `(error=${sanitizeMcpDiagnostic(err) ?? 'unknown error'})`,
      );
      throw err;
    }
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) throw new Error('Codex app-server client is closed');

    const command = this.opts.codexPathOverride?.trim() || resolveCodexBinary() || 'codex';
    const env = { ...this.opts.env };
    if (!this.opts.codexPathOverride?.trim()) {
      prependResolvedCodexPathDirs(env);
    }

    const child = spawn(command, ['app-server', '--stdio'], {
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      env,
      stdio: 'pipe',
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
      logger.debug('[codex-app-server] stderr activity', {
        event: 'codex_app_server_stderr',
        processGeneration: this.processGeneration,
        processPid: child.pid ?? null,
        bytes: Buffer.byteLength(chunk, 'utf8'),
        sanitizedTail: safeTail,
        contentOmitted: safeTail === null,
      });
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

  private requestRaw<T = unknown>(method: string, params: unknown): Promise<T> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    const msg = JSON.stringify({ method, id, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      child.stdin.write(`${msg}\n`, (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
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
      logger.warn('[codex-app-server] failed to parse stdout line', {
        event: 'codex_app_server_stdout_parse_failed',
        processGeneration: this.processGeneration,
        processPid: sourceChild.pid ?? null,
        bytes: Buffer.byteLength(line, 'utf8'),
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;

    if ('id' in obj && (Object.prototype.hasOwnProperty.call(obj, 'result') || 'error' in obj)) {
      this.handleResponse(obj as unknown as JsonRpcResponse);
      return;
    }

    if (typeof obj.method === 'string' && 'id' in obj) {
      this.respondUnsupportedServerRequest(obj.id, obj.method);
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

  private respondUnsupportedServerRequest(id: unknown, method: string): void {
    try {
      this.child?.stdin.write(
        `${JSON.stringify({
          id,
          error: { code: -32601, message: `Unsupported server request: ${method}` },
        })}\n`,
      );
    } catch {
      // ignore
    }
  }

  private dispatchNotification(notification: CodexAppServerNotification): void {
    const mcpStartup = this.mcpStartupObserver.observe(notification);
    if (mcpStartup?.level === 'warn') logger.warn(mcpStartup.message);
    else if (mcpStartup) logger.info(mcpStartup.message);
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(notification);
      } catch (err) {
        logger.warn('[codex-app-server] notification listener failed', err);
      }
    }
  }

  private handleExit(exitedChild: ChildProcessWithoutNullStreams, err: Error): void {
    // `error` is normally followed by `exit`; an old child's late exit may also arrive after a
    // replacement process was spawned. Only the currently-owned child may clear state/reject RPCs.
    this.retireCurrentProcess(exitedChild, err);
  }

  private retireCurrentProcess(
    exitedChild: ChildProcessWithoutNullStreams,
    err: Error,
  ): boolean {
    if (this.child !== exitedChild) return false;
    this.child = null;
    this.currentStderrTail = '';
    this.initializePromise = null;
    this.processGeneration++;
    this.mcpStartupObserver.reset();
    this.rejectAll(err);
    this.dispatchNotification({
      method: 'error',
      params: {
        error: {
          message: err.message,
          codexErrorInfo: null,
          additionalDetails: null,
        },
        willRetry: false,
      },
    });
    return true;
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
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
