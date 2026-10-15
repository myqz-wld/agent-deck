import type { AgentEventKind } from '@shared/types';
import {
  createCodexAppServerTranslateState,
  translateCodexAppServerNotification,
} from '../app-server/translate';
import { getNotificationTurnId, readTerminalError } from '../app-server/notification-helpers';
import {
  clearCodexLiveTokenEstimateCore,
  handleCodexNotificationForLiveRateCore,
  observeCodexNotificationUsageCore,
} from './live-token-rate-core';
import type { CodexBridgeOptions, InternalSession } from './types';
import type { CodexBridgeRuntimeHost } from './runtime-host-core';
import type { CodexHostSessionCommand } from '../session-commands';
import { completedSessionCommandText, failedSessionCommandText } from '@core/system-status-copy';
import { compactionRecord, type CompactionSnapshot } from '@shared/compaction';

export interface CodexSessionCommandContext {
  sessions: ReadonlyMap<string, InternalSession>;
  emit: CodexBridgeOptions['emit'];
  runtimeHost: CodexBridgeRuntimeHost;
  runTurnLoop(session: InternalSession, sessionId: string): Promise<void>;
}

export class CodexSessionCommandController {
  private compactionSequence = 0;
  constructor(private readonly context: CodexSessionCommandContext) {}

  async execute(sessionId: string, command: CodexHostSessionCommand): Promise<void> {
    const session = this.requireIdleSession(sessionId);
    session.activeControlCommand = command;
    session.turnLoopRunning = true;
    if (command === 'compact') {
      void this.compact(session).finally(() => this.release(session));
      return;
    }
    try {
      await this.clear(session);
      this.emitCommandOutcome(session, 'clear', { status: 'completed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitCommandOutcome(session, 'clear', { status: 'failed', detail: message });
      throw error;
    } finally {
      this.release(session);
    }
  }

  private requireIdleSession(sessionId: string): InternalSession {
    const session = this.context.sessions.get(sessionId);
    if (!session || session.intentionallyClosed) {
      throw new Error('Codex 会话不在运行中，无法执行命令。');
    }
    if (
      session.componentRefresh?.blocked ||
      session.turnLoopRunning ||
      session.currentTurn ||
      session.pendingTurns.length > 0 ||
      session.activeControlCommand ||
      session.cwdTransitionGeneration != null ||
      session.retireAfterCurrentTurn
    ) {
      throw new Error('Codex 当前有任务或排队消息，请等待完成后再执行该命令。');
    }
    return session;
  }

  private async clear(session: InternalSession): Promise<void> {
    const freshThread = session.thread.createFreshThread();
    const nextThreadId = await freshThread.ensureReady();
    if (
      this.context.sessions.get(session.applicationSid) !== session ||
      session.intentionallyClosed
    ) {
      throw new Error('Codex 会话在清理上下文时已关闭。');
    }
    this.context.runtimeHost.sessions.updateCliSessionId(
      session.applicationSid,
      nextThreadId,
    );
    clearCodexLiveTokenEstimateCore(
      session,
      session.applicationSid,
      Date.now(),
      this.context.runtimeHost.liveRate,
    );
    session.thread = freshThread;
    session.threadId = nextThreadId;
    session.runtimeIdentity = freshThread.getRuntimeIdentity();
    session.codexTokenUsageWatermark = undefined;
    this.context.emit({
      sessionId: session.applicationSid,
      agentId: 'codex-cli',
      kind: 'context-usage',
      payload: { usedTokens: null },
      ts: Date.now(),
      source: 'sdk',
    });
  }

  private async compact(session: InternalSession): Promise<void> {
    const startedAt = Date.now();
    const compaction: CompactionSnapshot = {
      id: `codex-command:${session.threadId}:${startedAt}:${++this.compactionSequence}`, status: 'running', trigger: 'manual', startedAt,
    };
    this.emit(session, 'context-compaction-start', { compaction });
    const controller = new AbortController();
    session.currentTurn = controller;
    const translateState = createCodexAppServerTranslateState();
    let terminalFailure: string | null = null;
    let interrupted = false;
    try {
      const { events } = await session.thread.compactStreamed();
      for await (const event of events) {
        if (event.type !== 'server.notification') continue;
        session.runtimeIdentity = event.runtimeIdentity;
        terminalFailure =
          readTerminalError(event.notification)?.message ?? terminalFailure;
        if (event.notification.method === 'turn/completed'
          && compactionRecord(compactionRecord(event.notification.params).turn).status === 'interrupted') interrupted = true;
        const turnId = getNotificationTurnId(event.notification);
        if (event.notification.method === 'turn/started' && turnId) {
          session.currentTurnId = turnId;
        }
        const usageObservation = observeCodexNotificationUsageCore(
          event.notification,
          session,
        );
        handleCodexNotificationForLiveRateCore(
          event.notification,
          session,
          session.applicationSid,
          Date.now(),
          this.context.runtimeHost.liveRate,
          usageObservation,
        );
        translateCodexAppServerNotification(
          event.notification,
          (kind, payload) => {
            if (kind === 'context-compaction-end') {
              const summary = compactionRecord(payload).summary;
              if (typeof summary === 'string') compaction.summary = summary;
            }
            if (kind === 'context-usage' || kind === 'token-usage') {
              this.emit(session, kind, payload);
            }
          },
          {
            model:
              event.runtimeIdentity?.model ??
              this.context.runtimeHost.records.get(session.applicationSid)?.model ??
              null,
            runtimeIdentity: event.runtimeIdentity,
            state: translateState,
            tokenUsageObservation: usageObservation,
            usageMessageNamespace: session.threadId ?? session.applicationSid,
            observeIgnoredItemType: this.context.runtimeHost.observeIgnoredAppServerItemType,
            observeHeuristicStreamError: this.context.runtimeHost.observeHeuristicStreamError,
          },
        );
      }
      if (terminalFailure) {
        this.emitCommandOutcome(
          session,
          'compact',
          { status: 'failed', detail: interrupted ? '操作已中断' : terminalFailure },
          interrupted ? 'interrupted' : 'error', compaction,
        );
      } else {
        this.emitCommandOutcome(session, 'compact', { status: 'completed' }, 'error', compaction);
      }
    } catch (error) {
      clearCodexLiveTokenEstimateCore(
        session,
        session.applicationSid,
        Date.now(),
        this.context.runtimeHost.liveRate,
      );
      if (controller.signal.aborted || interrupted) {
        this.emitCommandOutcome(
          session,
          'compact',
          { status: 'failed', detail: '操作已中断' },
          'interrupted',
          compaction,
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.emitCommandOutcome(session, 'compact', { status: 'failed', detail: message }, 'error', compaction);
    } finally {
      session.currentTurn = null;
      session.currentTurnId = null;
    }
  }

  private release(session: InternalSession): void {
    session.activeControlCommand = null;
    session.turnLoopRunning = false;
    void session.componentRefresh?.checkpoint();
    if (
      this.context.sessions.get(session.applicationSid) === session &&
      !session.intentionallyClosed &&
      session.pendingTurns.length > 0
    ) {
      void this.context.runTurnLoop(session, session.applicationSid);
    }
  }

  private emitCommandOutcome(
    session: InternalSession,
    command: CodexHostSessionCommand,
    outcome: { status: 'completed' } | { status: 'failed'; detail: string },
    failedSubtype: 'error' | 'interrupted' = 'error',
    compaction?: CompactionSnapshot,
  ): void {
    const failed = outcome.status === 'failed';
    this.emit(session, 'message', {
      role: 'system',
      text: failed
        ? failedSessionCommandText('Codex', command, outcome.detail)
        : completedSessionCommandText(
            'Codex',
            command,
            command === 'clear' ? '已开始新对话，原时间线保留' : undefined,
          ),
      ...(failed ? { error: true } : {}),
      sessionCommandStatus: { command, status: outcome.status },
      ...(compaction ? { compaction: { ...compaction,
        status: failed ? failedSubtype === 'interrupted' ? 'interrupted' : 'failed' : 'completed',
        completedAt: Date.now(), durationMs: Math.max(0, Date.now() - compaction.startedAt!),
        ...(failed ? { error: outcome.detail } : {}),
      } } : {}),
    });
    this.emit(session, 'finished', {
      ok: !failed,
      subtype: failed ? failedSubtype : 'end_turn',
    });
  }

  private emit(session: InternalSession, kind: AgentEventKind, payload: unknown): void {
    this.context.emit({
      sessionId: session.applicationSid,
      agentId: 'codex-cli',
      kind,
      payload,
      ts: Date.now(),
      source: 'sdk',
    });
  }
}
