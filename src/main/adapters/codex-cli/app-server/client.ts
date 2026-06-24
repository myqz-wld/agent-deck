import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import {
  prependResolvedCodexPathDirs,
  resolveCodexBinary,
} from '../sdk-bridge/codex-binary';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import { AsyncNotificationQueue } from './async-notification-queue';
import {
  formatRpcError,
  getNotificationThreadId,
  getNotificationTurnId,
  isTerminalForTurn,
  readCompletedAgentMessageText,
} from './notification-helpers';
import type {
  CodexAppServerNotification,
  CodexAppServerOptions,
  CodexAppServerRunResult,
  CodexAppServerStreamEvent,
  CodexAppServerUserInput,
  JsonRpcResponse,
} from './protocol';
import {
  buildThreadConfig,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
} from './thread-params';
import log from '@main/utils/logger';

const logger = log.scope('codex-app-server');

export type {
  CodexAppServerNotification,
  CodexAppServerOptions,
  CodexAppServerRunResult,
  CodexAppServerStreamEvent,
  CodexAppServerUserInput,
} from './protocol';

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

  startThread(options: CodexThreadOptions): CodexAppServerThread {
    return new CodexAppServerThread(this, { mode: 'start', options });
  }

  resumeThread(threadId: string, options: CodexThreadOptions): CodexAppServerThread {
    return new CodexAppServerThread(this, { mode: 'resume', threadId, options });
  }

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

type ThreadMode =
  | { mode: 'start'; options: CodexThreadOptions }
  | { mode: 'resume'; threadId: string; options: CodexThreadOptions };

export class CodexAppServerThread {
  private threadId: string | null;
  private started = false;
  private readyPromise: Promise<string> | null = null;
  private readyGeneration = -1;
  private activeTurnId: string | null = null;

  constructor(
    private readonly client: CodexAppServerClient,
    private mode: ThreadMode,
  ) {
    this.threadId = mode.mode === 'resume' ? mode.threadId : null;
  }

  updateSandboxMode(
    sandboxMode: CodexThreadOptions['sandboxMode'],
    opts: {
      networkAccessEnabled?: boolean;
      additionalDirectories?: readonly string[];
    } = {},
  ): void {
    const options: CodexThreadOptions = {
      ...this.mode.options,
      sandboxMode,
      ...(opts.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: opts.networkAccessEnabled }
        : {}),
      ...(opts.additionalDirectories !== undefined
        ? { additionalDirectories: [...opts.additionalDirectories] }
        : {}),
    };
    this.mode =
      this.mode.mode === 'resume'
        ? { mode: 'resume', threadId: this.mode.threadId, options }
        : { mode: 'start', options };
  }

  async runStreamed(
    input: CodexAppServerUserInput[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<CodexAppServerStreamEvent> }> {
    return {
      events: this.runTurn(input, opts?.signal),
    };
  }

  async run(
    input: CodexAppServerUserInput[],
    opts?: { signal?: AbortSignal },
  ): Promise<CodexAppServerRunResult> {
    const { events } = await this.runStreamed(input, opts);
    const messages: string[] = [];
    for await (const ev of events) {
      if (ev.type !== 'server.notification') continue;
      const text = readCompletedAgentMessageText(ev.notification);
      if (text) messages.push(text);
    }
    return { finalResponse: messages.join('\n') };
  }

  async ensureReady(): Promise<string> {
    const threadId = await this.ensureThread();
    this.started = true;
    return threadId;
  }

  async steer(input: CodexAppServerUserInput[], expectedTurnId: string): Promise<void> {
    const threadId = await this.ensureThread();
    await this.client.request('turn/steer', {
      threadId,
      expectedTurnId,
      input,
    });
  }

  async interrupt(turnId = this.activeTurnId): Promise<void> {
    const threadId = this.threadId;
    if (!threadId || !turnId) return;
    // 进程已死：handleExit 已向所有 subscriber 派发 synthetic error（terminal）终结队列，
    // 这里静默返回即可；不能走 request —— ensureProcess 会为这条 interrupt 重新 spawn 进程。
    if (!this.client.isProcessAlive) return;
    await this.client.request('turn/interrupt', { threadId, turnId });
  }

  private async *runTurn(
    input: CodexAppServerUserInput[],
    signal: AbortSignal | undefined,
  ): AsyncIterable<CodexAppServerStreamEvent> {
    let unsub: Unsubscribe | null = null;
    let abortListener: (() => void) | null = null;
    const queue = new AsyncNotificationQueue<CodexAppServerNotification>();
    try {
      const threadId = await this.ensureThread();
      if (!this.started) {
        this.started = true;
        yield { type: 'thread.started', thread_id: threadId };
      }

      // 本 turn 是否已见 `turn/started` 通知。stdout 是单管道 FIFO：上一个 turn 的迟到
      // `turn/completed` 一定先于本 turn 的 `turn/started` 到达 → activeTurnId 还未知时
      // （turn/start 响应与 turn/started 通知都没到），未见 started 就来的 completed 是
      // 上一个 turn 的尾包，不能当 terminal 关队列（否则本 turn 事件全部静默丢失，turn
      // 在服务端继续跑但 UI 看不到任何输出）。
      let turnStartSeen = false;
      unsub = this.client.subscribe((notification) => {
        const notificationThreadId = getNotificationThreadId(notification);
        if (notificationThreadId && notificationThreadId !== threadId) return;
        if (notification.method === 'turn/started') {
          const turnId = getNotificationTurnId(notification);
          if (turnId) this.activeTurnId = turnId;
          turnStartSeen = true;
        }
        queue.push(notification);
        if (isTerminalForTurn(notification, this.activeTurnId, turnStartSeen)) {
          this.activeTurnId = null;
          queue.close();
        }
      });

      if (signal?.aborted) throw new Error('Codex turn interrupted');
      const abortPromise = new Promise<never>((_, reject) => {
        if (!signal) return;
        abortListener = () => {
          void this.interrupt().catch((err) => {
            logger.warn('[codex-app-server] turn interrupt request failed', err);
            // turn/start 已 resolve 后 abortPromise 的 reject 不再被任何人 await（race 已
            // settle），中断完全依赖 interrupt RPC 成功 → 服务端发 terminal 通知关队列。
            // RPC 失败时服务端不会再发 terminal → for-await 永久挂起。主动 throw 队列让
            // generator 抛出，thread-loop catch 按 signal.aborted 走 finished:interrupted。
            // 队列已 close（terminal 已到 / 进程退出 synthetic error）时 throw 是 no-op。
            queue.throw(new Error('Codex turn interrupted'));
          });
          reject(new Error('Codex turn interrupted'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      });

      const response = await Promise.race([
        this.client.request<{ turn: { id: string } }>(
          'turn/start',
          buildTurnStartParams(threadId, input, this.mode.options, this.client.baseConfig),
        ),
        abortPromise,
      ]);
      this.activeTurnId = response.turn.id;

      for await (const notification of queue) {
        yield { type: 'server.notification', notification };
      }
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
      unsub?.();
      this.activeTurnId = null;
      queue.close();
    }
  }

  private async ensureThread(): Promise<string> {
    if (this.readyPromise && this.readyGeneration === this.client.generation) {
      return this.readyPromise;
    }
    this.readyGeneration = this.client.generation;
    this.readyPromise = (async () => {
      if (this.threadId) {
        const result = await this.client.request<{ thread: { id: string } }>(
          'thread/resume',
          buildThreadResumeParams(this.threadId, this.mode.options, this.client.baseConfig),
        );
        this.threadId = result.thread.id;
        return this.threadId;
      }

      const result = await this.client.request<{ thread: { id: string } }>(
        'thread/start',
        buildThreadStartParams(this.mode.options, this.client.baseConfig),
      );
      this.threadId = result.thread.id;
      return this.threadId;
    })();
    return this.readyPromise;
  }
}

export const __testables = {
  buildThreadStartParams,
  buildThreadResumeParams,
  buildTurnStartParams,
  buildThreadConfig,
};
