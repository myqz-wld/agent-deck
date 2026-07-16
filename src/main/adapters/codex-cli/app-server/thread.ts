import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerClient } from './client';
import { AsyncNotificationQueue } from './async-notification-queue';
import {
  getNotificationThreadId,
  getNotificationTurnId,
  isTerminalForTurn,
  readCompletedAgentMessageText,
  readTerminalErrorText,
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
import {
  firstModelEventTimeoutMessage,
  isCodexModelActivity,
} from './first-model-event-watchdog';
import { buildCodexTurnWatchdogDiagnostic } from './turn-watchdog-diagnostics';
import log from '@main/utils/logger';

const logger = log.scope('codex-app-server');
const MAX_PRE_ACCEPTANCE_TURNS = 8;
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
      const terminalError = readTerminalErrorText(ev.notification);
      if (terminalError) throw new Error(terminalError);
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
    let firstModelEventTimer: ReturnType<typeof setTimeout> | null = null;
    const queue = new AsyncNotificationQueue<CodexAppServerNotification>();
    try {
      const threadId = await this.ensureThread();
      if (!this.started) {
        this.started = true;
        yield { type: 'thread.started', thread_id: threadId };
      }

      // Stdout is FIFO. A completion seen before this turn's started notification belongs to the
      // previous turn and must not close this turn's queue.
      const turnGeneration = this.client.generation;
      let turnStartSeen = false;
      let turnAccepted = false;
      let turnRequestIssued = false;
      let modelActivitySeen = false;
      let terminalSeen = false;
      let firstModelEventWatchdogStarted = false;
      let turnStartResponsePending = true;
      let acceptanceSource: TurnAcceptanceBoundary['source'] | null = null;
      let acceptedAtMs: number | null = null;
      let deadlineAtMs: number | null = null;
      let notificationCount = 0;
      let lastScopedNotificationMethod: string | null = null;
      let lastScopedNotificationAtMs: number | null = null;
      const preAcceptanceCandidates = new Map<string, {
        model: boolean;
        terminal: boolean;
        count: number;
        lastMethod: string;
        lastAtMs: number;
      }>();
      let resolveTurnStarted!: (boundary: TurnAcceptanceBoundary) => void;
      const turnStartedPromise = new Promise<TurnAcceptanceBoundary>((resolve) => {
        resolveTurnStarted = resolve;
      });
      const clearFirstModelEventTimer = (): void => {
        if (!firstModelEventTimer) return;
        clearTimeout(firstModelEventTimer);
        firstModelEventTimer = null;
      };
      const recordAcceptanceBoundary = (source: TurnAcceptanceBoundary['source']): void => {
        if (acceptanceSource) return;
        const timeoutMs = this.client.firstModelEventTimeoutMs;
        acceptanceSource = source;
        acceptedAtMs = Date.now();
        deadlineAtMs = acceptedAtMs + timeoutMs;
      };
      const recordFirstModelActivity = (turnId: string): void => {
        if (modelActivitySeen) return;
        modelActivitySeen = true;
        clearFirstModelEventTimer();
        if (!acceptanceSource || acceptedAtMs === null || deadlineAtMs === null) return;
        logger.debug('[codex-app-server] first model event received',
          buildCodexTurnWatchdogDiagnostic({
            phase: 'first_model_event',
            threadId,
            turnId,
            acceptanceSource,
            acceptedAtMs,
            deadlineAtMs,
            nowMs: Date.now(),
            responsePending: turnStartResponsePending,
            notificationCount,
            lastScopedNotificationMethod,
            lastScopedNotificationAtMs,
            process: this.client.getProcessDiagnosticSnapshot(),
          }));
      };
      const armFirstModelEventWatchdog = (
        turnId: string,
        source: TurnAcceptanceBoundary['source'],
      ): void => {
        // turn/started and the RPC response describe the same acceptance boundary. Whichever
        // arrives first owns one absolute deadline; the later signal must never reset it.
        recordAcceptanceBoundary(source);
        if (firstModelEventWatchdogStarted || modelActivitySeen || terminalSeen) return;
        firstModelEventWatchdogStarted = true;
        const timeoutMs = this.client.firstModelEventTimeoutMs;
        const nowMs = acceptedAtMs!;
        const diagnostic = (phase: 'armed' | 'first_model_event' | 'timeout', atMs: number) =>
          buildCodexTurnWatchdogDiagnostic({
            phase,
            threadId,
            turnId,
            acceptanceSource: acceptanceSource!,
            acceptedAtMs: acceptedAtMs!,
            deadlineAtMs: deadlineAtMs!,
            nowMs: atMs,
            responsePending: turnStartResponsePending,
            notificationCount,
            lastScopedNotificationMethod,
            lastScopedNotificationAtMs,
            process: this.client.getProcessDiagnosticSnapshot(),
          });
        logger.debug('[codex-app-server] turn accepted; first-model watchdog armed',
          diagnostic('armed', nowMs));
        firstModelEventTimer = setTimeout(() => {
          firstModelEventTimer = null;
          const error = new Error(firstModelEventTimeoutMessage(timeoutMs));
          logger.warn('[codex-app-server] first model event timeout; recycle initiated',
            diagnostic('timeout', Date.now()));
          const recycled = this.client.abortTurnAndRecycleGeneration(
            turnGeneration,
            threadId,
            turnId,
            error,
          );
          if (!recycled) queue.throw(error);
        }, timeoutMs);
        firstModelEventTimer.unref();
      };
      const consumePreAcceptanceCandidates = (turnId: string): void => {
        const matching = preAcceptanceCandidates.get(turnId);
        preAcceptanceCandidates.clear();
        if (matching) {
          notificationCount += matching.count;
          lastScopedNotificationMethod = matching.lastMethod;
          lastScopedNotificationAtMs = matching.lastAtMs;
        }
        if (matching?.model) recordFirstModelActivity(turnId);
        if (matching?.terminal) {
          terminalSeen = true;
          clearFirstModelEventTimer();
          this.activeTurnId = null;
          queue.close();
        }
      };
      unsub = this.client.subscribe((notification) => {
        const notificationThreadId = getNotificationThreadId(notification);
        if (notificationThreadId && notificationThreadId !== threadId) return;
        let startedBoundary: TurnAcceptanceBoundary | null = null;
        if (
          notification.method === 'turn/started' &&
          turnRequestIssued &&
          notificationThreadId === threadId
        ) {
          const turnId = getNotificationTurnId(notification);
          if (turnId) {
            this.activeTurnId = turnId;
            turnStartSeen = true;
            turnAccepted = true;
            startedBoundary = { turnId, source: 'notification' };
          }
        }
        if (turnAccepted && notificationMatchesTurn(notification, threadId, this.activeTurnId)) {
          notificationCount += 1;
          lastScopedNotificationMethod = notification.method;
          lastScopedNotificationAtMs = Date.now();
        }
        if (startedBoundary) {
          armFirstModelEventWatchdog(startedBoundary.turnId, startedBoundary.source);
          resolveTurnStarted(startedBoundary);
        }
        const notificationTurnId = getNotificationTurnId(notification);
        if (
          turnRequestIssued &&
          !turnAccepted &&
          notificationTurnId
        ) {
          // readline may synchronously deliver a turn/start response and subsequent notifications
          // before the response Promise continuation runs. Retain only a bounded set of turn-scoped
          // candidates;
          // the accepted response id decides whether they belong to this turn.
          let candidate = preAcceptanceCandidates.get(notificationTurnId);
          if (!candidate) {
            if (preAcceptanceCandidates.size >= MAX_PRE_ACCEPTANCE_TURNS) {
              const oldestTurnId = preAcceptanceCandidates.keys().next().value;
              if (oldestTurnId) preAcceptanceCandidates.delete(oldestTurnId);
            }
            candidate = {
              model: false,
              terminal: false,
              count: 0,
              lastMethod: notification.method,
              lastAtMs: Date.now(),
            };
            preAcceptanceCandidates.set(notificationTurnId, candidate);
          }
          candidate.count += 1;
          candidate.lastMethod = notification.method;
          candidate.lastAtMs = Date.now();
          candidate.model ||= isCodexModelActivity(notification);
          candidate.terminal ||= isTerminalForTurn(notification, notificationTurnId, true);
        }
        if (
          !modelActivitySeen &&
          (turnStartSeen || turnAccepted) &&
          notificationMatchesTurn(notification, threadId, this.activeTurnId) &&
          isCodexModelActivity(notification)
        ) {
          recordFirstModelActivity(this.activeTurnId ?? 'unknown');
        }
        queue.push(notification);
        if (isTerminalForTurn(notification, this.activeTurnId, turnStartSeen)) {
          terminalSeen = true;
          clearFirstModelEventTimer();
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

      turnRequestIssued = true;
      const turnStartRequest = this.client.request<{ turn: { id: string } }>(
        'turn/start',
        buildTurnStartParams(threadId, input, this.mode.options, this.client.baseConfig, {
          ...(opts?.outputSchema !== undefined ? { outputSchema: opts.outputSchema } : {}),
          ...(opts?.environments !== undefined ? { environments: [] } : {}),
          ...(opts?.runtimeWorkspaceRoots !== undefined
            ? { runtimeWorkspaceRoots: [...opts.runtimeWorkspaceRoots] }
            : {}),
        }),
      );
      const responsePromise = turnStartRequest.then<TurnAcceptanceBoundary>(
        (response) => {
          turnStartResponsePending = false;
          return { turnId: response.turn.id, source: 'response' };
        },
        (error) => {
          turnStartResponsePending = false;
          throw error;
        },
      );
      const acceptance = await Promise.race([
        responsePromise,
        turnStartedPromise,
        abortPromise,
      ]);
      this.activeTurnId = acceptance.turnId;
      turnAccepted = true;
      recordAcceptanceBoundary(acceptance.source);
      consumePreAcceptanceCandidates(acceptance.turnId);
      armFirstModelEventWatchdog(acceptance.turnId, acceptance.source);

      for await (const notification of queue) {
        yield { type: 'server.notification', notification };
      }
    } finally {
      if (firstModelEventTimer) clearTimeout(firstModelEventTimer);
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
    const attempt = (async () => {
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
    this.readyPromise = attempt;
    try {
      return await attempt;
    } catch (err) {
      // A required MCP startup failure rejects thread/start or thread/resume while app-server stays
      // alive. Do not pin that same-generation rejection forever: watcher/user retries must issue a
      // fresh thread boundary RPC after the transient endpoint/auth problem is corrected.
      if (this.readyPromise === attempt) {
        this.readyPromise = null;
        this.readyGeneration = -1;
      }
      throw err;
    }
  }
}

function notificationMatchesTurn(
  notification: CodexAppServerNotification,
  expectedThreadId: string,
  activeTurnId: string | null,
): boolean {
  const notificationTurnId = getNotificationTurnId(notification);
  if (notificationTurnId) return !activeTurnId || notificationTurnId === activeTurnId;
  const notificationThreadId = getNotificationThreadId(notification);
  // Production callers keep one active turn per thread: the live bridge serializes its message
  // queue, and each pooled oneshot creates a distinct thread. Thread scope is therefore sufficient.
  if (notificationThreadId) return notificationThreadId === expectedThreadId;
  // Live sessions own one client each, but the oneshot pool intentionally runs concurrent threads
  // on a shared client. An unscoped model notification cannot safely disarm any one watchdog.
  return false;
}

interface TurnAcceptanceBoundary {
  turnId: string;
  source: 'notification' | 'response';
}
