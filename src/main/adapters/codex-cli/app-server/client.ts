import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import {
  prependResolvedCodexPathDirs,
  resolveCodexBinary,
} from '../sdk-bridge/codex-binary';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import { formatRpcError } from './notification-helpers';
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
  private lastStderr = '';
  private closed = false;
  private processGeneration = 0;

  constructor(private readonly opts: CodexAppServerOptions) {}

  get baseConfig(): CodexConfigObject | null {
    return this.opts.config ?? null;
  }

  get generation(): number {
    return this.processGeneration;
  }

  /**
   * 子进程当前是否存活。Thread.interrupt 用：进程已退出时 turn 早已被 handleExit 的
   * synthetic error 通知终结，此时再走 request('turn/interrupt') 会经 ensureProcess
   * **重新拉起一个全新 app-server 进程**只为发一条无意义的 interrupt —— 该 guard 避免之。
   */
  get isProcessAlive(): boolean {
    return this.child !== null;
  }

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
  readThread(threadId: string): Promise<CodexAppServerThreadReadResult> {
    return this.request('thread/read', { threadId, includeTurns: true });
  }
  startThreadEager(options: CodexThreadOptions): Promise<CodexAppServerThreadCreateResult> {
    return this.request('thread/start', buildThreadStartParams(options, this.baseConfig));
  }
  forkThread(sourceThreadId: string, lastTurnId: string, options: CodexThreadOptions): Promise<CodexAppServerThreadCreateResult> {
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
    return this.requestRaw<T>(method, params);
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  dispose(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      child.kill();
    }
    this.rejectAll(new Error('Codex app-server disposed'));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
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
    return this.initializePromise;
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

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.lastStderr = `${this.lastStderr}${chunk}`.slice(-8000);
      logger.debug(`[codex-app-server] stderr: ${chunk.trimEnd()}`);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    child.on('error', (err) => this.handleExit(err));
    child.on('exit', (code, signal) => {
      const suffix = this.lastStderr ? `: ${this.lastStderr.trim()}` : '';
      this.handleExit(new Error(`Codex app-server exited code=${code} signal=${signal}${suffix}`));
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

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      logger.warn('[codex-app-server] failed to parse stdout line', err, line);
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
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(notification);
      } catch (err) {
        logger.warn('[codex-app-server] notification listener failed', err);
      }
    }
  }

  private handleExit(err: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.child = null;
    this.initializePromise = null;
    this.processGeneration++;
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
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

export const __testables = {
  buildThreadStartParams,
  buildThreadResumeParams,
  buildThreadForkParams,
  buildTurnStartParams,
  buildThreadConfig,
};
