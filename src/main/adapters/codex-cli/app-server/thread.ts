import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerClient } from './client';
import { AsyncNotificationQueue } from './async-notification-queue';
import {
  getNotificationThreadId,
  getNotificationTurnId,
  isTerminalForTurn,
  readCompletedAgentMessageText,
} from './notification-helpers';
import type {
  CodexAppServerNotification,
  CodexAppServerRunResult,
  CodexAppServerStreamEvent,
  CodexAppServerUserInput,
  JsonObject,
} from './protocol';
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
} from './thread-params';
import log from '@main/utils/logger';

const logger = log.scope('codex-app-server');
type Unsubscribe = () => void;
type ThreadMode =
  | { mode: 'start'; options: CodexThreadOptions }
  | { mode: 'resume'; threadId: string; options: CodexThreadOptions };

export interface CodexAppServerRunOptions {
  signal?: AbortSignal;
  outputSchema?: JsonObject;
  environments?: readonly [];
  runtimeWorkspaceRoots?: readonly string[];
  maxOutputBytes?: number;
}

export class CodexAppServerThread {
  private threadId: string | null;
  private started = false;
  private readyPromise: Promise<string> | null = null;
  private readyGeneration = -1;
  private activeTurnId: string | null = null;

  constructor(
    private readonly client: CodexAppServerClient,
    private mode: ThreadMode,
    attachedGeneration?: number,
  ) {
    this.threadId = mode.mode === 'resume' ? mode.threadId : null;
    if (attachedGeneration !== undefined && this.threadId) {
      this.readyGeneration = attachedGeneration;
      this.readyPromise = Promise.resolve(this.threadId);
    }
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

  /** Apply model / effort to subsequent turns without interrupting an active turn. */
  async updateModelOptions(
    model: CodexThreadOptions['model'] | null,
    effort: CodexThreadOptions['modelReasoningEffort'] | null,
  ): Promise<void> {
    const threadId = await this.ensureThread();
    await this.client.request('thread/settings/update', {
      threadId,
      model,
      effort,
    });
    const options: CodexThreadOptions = { ...this.mode.options };
    if (model === null) delete options.model;
    else options.model = model;
    if (effort === null) delete options.modelReasoningEffort;
    else options.modelReasoningEffort = effort;
    this.mode =
      this.mode.mode === 'resume'
        ? { mode: 'resume', threadId: this.mode.threadId, options }
        : { mode: 'start', options };
  }

  async runStreamed(
    input: CodexAppServerUserInput[],
    opts?: CodexAppServerRunOptions,
  ): Promise<{ events: AsyncIterable<CodexAppServerStreamEvent> }> {
    return { events: this.runTurn(input, opts) };
  }

  async run(
    input: CodexAppServerUserInput[],
    opts?: CodexAppServerRunOptions,
  ): Promise<CodexAppServerRunResult> {
    const { events } = await this.runStreamed(input, opts);
    const messages: string[] = [];
    for await (const ev of events) {
      if (ev.type !== 'server.notification') continue;
      const text = readCompletedAgentMessageText(ev.notification);
      if (text) {
        messages.push(text);
        if (
          opts?.maxOutputBytes !== undefined &&
          Buffer.byteLength(messages.join('\n'), 'utf8') > opts.maxOutputBytes
        ) {
          throw new Error('Codex app-server output exceeded byte limit');
        }
      }
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
    await this.client.request('turn/steer', { threadId, expectedTurnId, input });
  }

  async interrupt(turnId = this.activeTurnId): Promise<void> {
    const threadId = this.threadId;
    if (!threadId || !turnId) return;
    // A dead process already terminated subscribers through a synthetic error. Do not restart it
    // solely to send a stale interrupt.
    if (!this.client.isProcessAlive) return;
    await this.client.request('turn/interrupt', { threadId, turnId });
  }

  private async *runTurn(
    input: CodexAppServerUserInput[],
    opts: CodexAppServerRunOptions | undefined,
  ): AsyncIterable<CodexAppServerStreamEvent> {
    const signal = opts?.signal;
    let unsub: Unsubscribe | null = null;
    let abortListener: (() => void) | null = null;
    const queue = new AsyncNotificationQueue<CodexAppServerNotification>();
    try {
      const threadId = await this.ensureThread();
      if (!this.started) {
        this.started = true;
        yield { type: 'thread.started', thread_id: threadId };
      }

      // Stdout is FIFO. A completion seen before this turn's started notification belongs to the
      // previous turn and must not close this turn's queue.
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
            // A failed interrupt produces no terminal notification. Throw the local queue so the
            // turn loop cannot hang indefinitely.
            queue.throw(new Error('Codex turn interrupted'));
          });
          reject(new Error('Codex turn interrupted'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      });

      const response = await Promise.race([
        this.client.request<{ turn: { id: string } }>(
          'turn/start',
          buildTurnStartParams(threadId, input, this.mode.options, this.client.baseConfig, {
            ...(opts?.outputSchema !== undefined ? { outputSchema: opts.outputSchema } : {}),
            ...(opts?.environments !== undefined ? { environments: [] } : {}),
            ...(opts?.runtimeWorkspaceRoots !== undefined
              ? { runtimeWorkspaceRoots: [...opts.runtimeWorkspaceRoots] }
              : {}),
          }),
        ),
        abortPromise,
      ]);
      this.activeTurnId = response.turn.id;

      for await (const notification of queue) {
        yield { type: 'server.notification', notification };
      }
    } finally {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
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
