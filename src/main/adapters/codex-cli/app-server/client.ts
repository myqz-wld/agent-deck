import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import {
  prependResolvedCodexPathDirs,
  resolveCodexBinary,
} from '../sdk-bridge/codex-binary';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import log from '@main/utils/logger';

const logger = log.scope('codex-app-server');

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };
type JsonObject = { [key: string]: JsonValue | undefined };

export type CodexAppServerUserInput =
  | { type: 'text'; text: string; text_elements: JsonValue[] }
  | { type: 'localImage'; path: string; detail?: string };

export type CodexAppServerNotification = { method: string; params?: unknown };

export type CodexAppServerStreamEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'server.notification'; notification: CodexAppServerNotification };

export interface CodexAppServerRunResult {
  finalResponse: string;
}

export interface CodexAppServerOptions {
  codexPathOverride?: string | null;
  config?: CodexConfigObject | null;
  env: Record<string, string>;
  skillExtraRoots?: string[];
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown } | string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type Unsubscribe = () => void;

class AsyncNotificationQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;
  private error: Error | null = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  throw(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

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
    private readonly mode: ThreadMode,
  ) {
    this.threadId = mode.mode === 'resume' ? mode.threadId : null;
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

function buildThreadStartParams(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return buildThreadCommonParams(options, baseConfig);
}

function buildThreadResumeParams(
  threadId: string,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return {
    threadId,
    ...buildThreadCommonParams(options, baseConfig),
  };
}

function buildThreadCommonParams(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return {
    cwd: options.workingDirectory,
    sandbox: options.sandboxMode,
    approvalPolicy: options.approvalPolicy ?? 'never',
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.developerInstructions !== undefined
      ? { developerInstructions: options.developerInstructions }
      : {}),
    config: buildThreadConfig(options, baseConfig),
  };
}

export const __testables = {
  buildThreadStartParams,
  buildThreadResumeParams,
  buildTurnStartParams,
  buildThreadConfig,
};

function buildThreadConfig(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  const config = cloneConfig(baseConfig);
  mergeJsonObject(config, cloneConfig(options.configOverrides ?? null));
  if (options.skipGitRepoCheck) {
    config.skip_git_repo_check = true;
  }
  if (options.modelReasoningEffort !== undefined) {
    config.model_reasoning_effort = options.modelReasoningEffort;
  }
  if (
    options.modelReasoningSummary !== undefined &&
    config.model_reasoning_summary === undefined
  ) {
    config.model_reasoning_summary = options.modelReasoningSummary;
  }
  if (options.networkAccessEnabled !== undefined || options.additionalDirectories !== undefined) {
    const workspace =
      config.sandbox_workspace_write &&
      typeof config.sandbox_workspace_write === 'object' &&
      !Array.isArray(config.sandbox_workspace_write)
        ? { ...(config.sandbox_workspace_write as JsonObject) }
        : {};
    if (options.networkAccessEnabled !== undefined) {
      workspace.network_access = options.networkAccessEnabled;
    }
    if (options.additionalDirectories !== undefined) {
      workspace.writable_roots = [...options.additionalDirectories];
    }
    config.sandbox_workspace_write = workspace;
  }
  return config;
}

function buildTurnStartParams(
  threadId: string,
  input: CodexAppServerUserInput[],
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  const effectiveConfig = buildThreadConfig(options, baseConfig);
  return {
    threadId,
    input,
    cwd: options.workingDirectory,
    approvalPolicy: options.approvalPolicy ?? 'never',
    sandboxPolicy: buildSandboxPolicy(options, effectiveConfig),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };
}

function buildSandboxPolicy(
  options: CodexThreadOptions,
  config: JsonObject,
): JsonObject {
  const networkAccess = resolveNetworkAccess(options, config);
  if (options.sandboxMode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  if (options.sandboxMode === 'read-only') {
    return { type: 'readOnly', networkAccess };
  }
  const workspaceConfig = readWorkspaceWriteConfig(config);
  return {
    type: 'workspaceWrite',
    writableRoots:
      options.additionalDirectories !== undefined
        ? [...options.additionalDirectories]
        : readStringArray(workspaceConfig.writable_roots),
    networkAccess,
    excludeTmpdirEnvVar: readBoolean(workspaceConfig.exclude_tmpdir_env_var) ?? false,
    excludeSlashTmp: readBoolean(workspaceConfig.exclude_slash_tmp) ?? false,
  };
}

function resolveNetworkAccess(
  options: CodexThreadOptions,
  config: JsonObject,
): boolean {
  if (options.networkAccessEnabled !== undefined) return options.networkAccessEnabled;
  return readBoolean(readWorkspaceWriteConfig(config).network_access) ?? false;
}

function readWorkspaceWriteConfig(config: JsonObject | CodexConfigObject | null): JsonObject {
  const value = (config as JsonObject | null)?.sandbox_workspace_write;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function readStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readBoolean(value: JsonValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function cloneConfig(config: CodexConfigObject | null): JsonObject {
  if (!config) return {};
  return JSON.parse(JSON.stringify(config)) as JsonObject;
}

function mergeJsonObject(target: JsonObject, override: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (isPlainJsonObject(existing) && isPlainJsonObject(value)) {
      target[key] = mergeJsonObject({ ...existing }, value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getNotificationThreadId(notification: CodexAppServerNotification): string | null {
  const params = notification.params;
  if (!params || typeof params !== 'object') return null;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === 'string' ? threadId : null;
}

function getNotificationTurnId(notification: CodexAppServerNotification): string | null {
  const params = notification.params;
  if (!params || typeof params !== 'object') return null;
  const directTurnId = (params as { turnId?: unknown }).turnId;
  if (typeof directTurnId === 'string') return directTurnId;
  const turn = (params as { turn?: { id?: unknown } }).turn;
  return typeof turn?.id === 'string' ? turn.id : null;
}

function isTerminalForTurn(
  notification: CodexAppServerNotification,
  activeTurnId: string | null,
  turnStartSeen: boolean,
): boolean {
  if (notification.method === 'turn/completed') {
    const turn = (notification.params as { turn?: { id?: unknown } } | undefined)?.turn;
    if (activeTurnId) return turn?.id === activeTurnId;
    // activeTurnId 未知时按 FIFO 时序判别：本 turn 的 completed 不可能先于自己的 started
    // 到达（同一 stdout 管道顺序投递）→ 未见 started 的 completed 是上一个 turn 的迟到
    // 尾包，不是本 turn terminal（详 runTurn 内 turnStartSeen 注释）。见过 started 但
    // turn id 未解析出时退回旧行为（completed 即 terminal）。
    return turnStartSeen;
  }
  if (notification.method !== 'error') return false;
  const params = notification.params as { willRetry?: unknown; turnId?: unknown } | undefined;
  if (params?.willRetry === true) return false;
  return !activeTurnId || params?.turnId === undefined || params.turnId === activeTurnId;
}

function readCompletedAgentMessageText(notification: CodexAppServerNotification): string {
  if (notification.method !== 'item/completed') return '';
  const params = asObject(notification.params);
  const item = asObject(params?.item);
  if (item?.type !== 'agentMessage') return '';
  return typeof item.text === 'string' ? item.text : '';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatRpcError(error: JsonRpcResponse['error']): string {
  if (!error) return 'Unknown Codex app-server error';
  if (typeof error === 'string') return error;
  const message = error.message ?? 'Unknown Codex app-server error';
  return error.code == null ? message : `${message} (code ${error.code})`;
}
