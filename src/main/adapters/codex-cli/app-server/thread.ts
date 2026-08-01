import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerClient } from './client';
import { AsyncNotificationQueue } from './async-notification-queue';
import {
  classifyTerminalForTurn,
  getNotificationThreadId,
  getNotificationTurnId,
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
import { AcceptedTurnCancellation, AcceptedTurnCancellationOwner } from './accepted-turn-cancellation';
import { collectCodexTurnOutput } from './turn-output';
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
  private activeTurnCancellation: AcceptedTurnCancellation | null = null;

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

  /** Apply cwd only to subsequent turn/start requests; the active turn keeps its original cwd. */
  updateWorkingDirectory(workingDirectory: string): void {
    const options: CodexThreadOptions = {
      ...this.mode.options,
      workingDirectory,
    };
    this.mode =
      this.mode.mode === 'resume'
        ? { mode: 'resume', threadId: this.mode.threadId, options }
        : { mode: 'start', options };
  }

  /** Apply an approval policy to subsequent turns without interrupting an active turn. */
  updateApprovalPolicy(
    approvalPolicy: CodexThreadOptions['approvalPolicy'] | null,
  ): void {
    const options: CodexThreadOptions = { ...this.mode.options };
    if (approvalPolicy === null) delete options.approvalPolicy;
    else options.approvalPolicy = approvalPolicy;
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
    return collectCodexTurnOutput(events, opts?.maxOutputBytes);
  }

  async ensureReady(signal?: AbortSignal): Promise<string> {
    const threadId = await this.ensureThread(signal);
    this.started = true;
    return threadId;
  }

  async steer(input: CodexAppServerUserInput[], expectedTurnId: string, signal?: AbortSignal): Promise<void> {
    const threadId = await this.ensureThread(signal);
    await this.client.request('turn/steer', { threadId, expectedTurnId, input }, signal);
  }

  async interrupt(turnId = this.activeTurnId): Promise<void> {
    const cancellation = this.activeTurnCancellation;
    if (cancellation && (!turnId || cancellation.turnId === turnId)) {
      await cancellation.cancel(new Error('Codex turn interrupted'));
      return;
    }
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
    let firstModelEventTimer: ReturnType<typeof setTimeout> | null = null;
    let cancellationOwner: AcceptedTurnCancellationOwner | null = null;
    let signalAbortListener: (() => void) | null = null;
    const queue = new AsyncNotificationQueue<CodexAppServerNotification>();
    try {
      const threadId = await this.ensureThread(signal);
      if (!this.started) {
        this.started = true;
        yield { type: 'thread.started', thread_id: threadId };
      }

      const turnGeneration = this.client.generation;
      let turnAccepted = false;
      let turnRequestIssued = false;
      let modelActivitySeen = false;
      let terminalSeen = false;
      let firstModelEventWatchdogStarted = false;
      let acceptanceSource: TurnAcceptanceBoundary['source'] | null = null;
      let acceptedAtMs: number | null = null;
      let deadlineAtMs: number | null = null;
      let notificationCount = 0;
      let lastScopedNotificationMethod: string | null = null;
      let lastScopedNotificationAtMs: number | null = null;
      const preAcceptanceCandidates = new Map<string, CodexAppServerNotification[]>();
      cancellationOwner = new AcceptedTurnCancellationOwner(
        this.client, turnGeneration, threadId,
        (error) => queue.throw(error),
      );
      const attachAcceptedTurn = (turnId: string): boolean => {
        let accepted: AcceptedTurnCancellation;
        try {
          accepted = cancellationOwner!.accept(turnId);
        } catch (error) {
          const acceptedError = error instanceof Error ? error : new Error(String(error));
          queue.throw(acceptedError);
          return false;
        }
        this.activeTurnCancellation = accepted;
        this.activeTurnId = turnId;
        return true;
      };
      signalAbortListener = () => cancellationOwner?.abort();
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
            responsePending: !turnAccepted,
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
            responsePending: !turnAccepted,
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
          const recycled = cancellationOwner?.isCancelling(turnId)
            ? this.client.recycleGeneration(turnGeneration, error, 'watchdog after cancellation')
            : this.client.abortTurnAndRecycleGeneration(turnGeneration, threadId, turnId, error);
          if (!recycled) queue.throw(error);
        }, timeoutMs);
        firstModelEventTimer.unref();
      };
      const consumePreAcceptanceCandidates = (turnId: string): void => {
        const matching = preAcceptanceCandidates.get(turnId);
        preAcceptanceCandidates.clear();
        for (const notification of matching ?? []) {
          handleAcceptedNotification(notification, turnId);
        }
      };
      const failMalformedTerminal = (
        notification: CodexAppServerNotification,
        turnId: string,
      ): void => {
        const error = new Error(
          `Codex app-server returned malformed ${notification.method} for accepted turn ${turnId}`,
        );
        const recycled = cancellationOwner?.isCancelling(turnId)
          ? this.client.recycleGeneration(turnGeneration, error, 'malformed terminal after cancellation')
          : this.client.abortTurnAndRecycleGeneration(turnGeneration, threadId, turnId, error);
        if (!recycled) queue.throw(error);
      };
      const handleAcceptedNotification = (
        notification: CodexAppServerNotification,
        turnId: string,
      ): void => {
        if (!this.client.acceptsNotificationForGeneration(turnGeneration)) return;
        const terminalState = classifyTerminalForTurn(notification, turnId);
        if (terminalState === 'other-turn' || terminalState === 'retrying') return;
        if (
          terminalState === 'malformed' ||
          terminalState === 'unattributed-completion'
        ) {
          failMalformedTerminal(notification, turnId);
          return;
        }
        const notificationTurnId = getNotificationTurnId(notification);
        if (terminalState === 'none' && notificationTurnId !== turnId) return;
        notificationCount += 1;
        lastScopedNotificationMethod = notification.method;
        lastScopedNotificationAtMs = Date.now();
        if (!modelActivitySeen && isCodexModelActivity(notification)) {
          recordFirstModelActivity(turnId);
        }
        queue.push(notification);
        if (terminalState === 'terminal') {
          terminalSeen = true;
          clearFirstModelEventTimer();
          cancellationOwner?.cancellation?.markTerminal();
          this.activeTurnId = null;
          queue.close();
        }
      };
      unsub = this.client.subscribe((notification) => {
        if (!this.client.acceptsNotificationForGeneration(turnGeneration)) return;
        const notificationThreadId = getNotificationThreadId(notification);
        if (notificationThreadId && notificationThreadId !== threadId) return;
        const notificationTurnId = getNotificationTurnId(notification);
        if (
          turnRequestIssued &&
          !turnAccepted &&
          notificationTurnId
        ) {
          if (
            notification.method === 'turn/started' &&
            notificationThreadId === threadId
          ) {
            attachAcceptedTurn(notificationTurnId);
          }
          if (cancellationOwner?.isCancelling(notificationTurnId)) {
            handleAcceptedNotification(notification, notificationTurnId);
            return;
          }
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
            candidate = [];
            preAcceptanceCandidates.set(notificationTurnId, candidate);
          }
          if (candidate.length < 256) {
            candidate.push(notification);
          } else {
            failMalformedTerminal(notification, notificationTurnId);
          }
          return;
        }
        if (turnAccepted && this.activeTurnId) {
          handleAcceptedNotification(notification, this.activeTurnId);
        }
      });

      if (signal?.aborted) throw new Error('Codex turn interrupted');

      turnRequestIssued = true;
      if (signal && signalAbortListener) signal.addEventListener('abort', signalAbortListener, { once: true });
      if (signal?.aborted) signalAbortListener?.();
      if (cancellationOwner.abortError) await cancellationOwner.acceptanceAbort;
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
      const response = signal
        ? await Promise.race([turnStartRequest, cancellationOwner.acceptanceAbort])
        : await turnStartRequest;
      const acceptance: TurnAcceptanceBoundary = {
        turnId: response.turn.id,
        source: 'response',
      };
      if (!attachAcceptedTurn(acceptance.turnId)) {
        throw new Error('Codex app-server returned conflicting turn acceptance ids');
      }
      turnAccepted = true;
      recordAcceptanceBoundary(acceptance.source);
      consumePreAcceptanceCandidates(acceptance.turnId);
      armFirstModelEventWatchdog(acceptance.turnId, acceptance.source);
      yield { type: 'turn.accepted', turn_id: acceptance.turnId };

      for await (const notification of queue) {
        yield { type: 'server.notification', notification };
      }
    } finally {
      if (firstModelEventTimer) clearTimeout(firstModelEventTimer);
      if (signal && signalAbortListener) {
        signal.removeEventListener('abort', signalAbortListener);
      }
      const acceptedCancellation = cancellationOwner?.cancellation;
      if (acceptedCancellation && !acceptedCancellation.isTerminal) {
        await acceptedCancellation.cancel(cancellationOwner?.abortError ??
          new Error('Codex turn consumer detached before completion'));
      }
      unsub?.();
      if (this.activeTurnCancellation === acceptedCancellation) this.activeTurnCancellation = null;
      this.activeTurnId = null;
      queue.close();
    }
  }

  private async ensureThread(signal?: AbortSignal): Promise<string> {
    if (this.readyPromise && this.readyGeneration === this.client.generation) {
      return signal
        ? this.client.runGenerationOperation(
            'thread readiness wait',
            signal,
            async () => this.readyPromise!,
          )
        : this.readyPromise;
    }
    this.readyGeneration = this.client.generation;
    const attempt = this.client.runGenerationOperation(
      this.threadId ? 'thread/resume readiness' : 'thread/start readiness',
      signal,
      async (operation) => {
        const options = await this.client.prepareThreadOptions(this.mode.options, operation);
        if (this.threadId) {
          const result = await operation.request<{ thread: { id: string } }>(
            'thread/resume',
            buildThreadResumeParams(this.threadId, options, this.client.baseConfig),
          );
          this.threadId = result.thread.id;
          return this.threadId;
        }

        const result = await operation.request<{ thread: { id: string } }>(
          'thread/start',
          buildThreadStartParams(options, this.client.baseConfig),
        );
        this.threadId = result.thread.id;
        return this.threadId;
      },
    );
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

interface TurnAcceptanceBoundary { turnId: string; source: 'notification' | 'response'; }
