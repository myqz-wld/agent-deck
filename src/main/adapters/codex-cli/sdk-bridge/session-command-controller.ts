import type { AgentEventKind } from '@shared/types';
import {
  createCodexAppServerTranslateState,
  translateCodexAppServerNotification,
} from '../app-server/translate';
import {
  getNotificationTurnId,
  readTerminalError,
} from '../app-server/notification-helpers';
import {
  clearCodexLiveTokenEstimateCore,
  handleCodexNotificationForLiveRateCore,
  observeCodexNotificationUsageCore,
} from './live-token-rate-core';
import type { CodexBridgeOptions, InternalSession } from './types';
import type { CodexBridgeRuntimeHost } from './runtime-host-core';
import type { CodexHostSessionCommand } from '../session-commands';

export interface CodexSessionCommandContext {
  sessions: ReadonlyMap<string, InternalSession>;
  emit: CodexBridgeOptions['emit'];
  runtimeHost: CodexBridgeRuntimeHost;
  runTurnLoop(session: InternalSession, sessionId: string): Promise<void>;
}

export class CodexSessionCommandController {
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
      this.emit(session, 'message', {
        role: 'system',
        text: 'Codex 已清空上下文并开始新对话；此前记录仍保留在 Agent Deck 时间线中。',
        sessionCommandStatus: { command: 'clear', status: 'completed' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(session, 'message', {
        role: 'system',
        text: `Codex 清理上下文失败：${message}`,
        error: true,
        sessionCommandStatus: { command: 'clear', status: 'failed' },
      });
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
      session.turnLoopRunning ||
      session.currentTurn ||
      session.pendingMessages.length > 0 ||
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
    const controller = new AbortController();
    session.currentTurn = controller;
    const translateState = createCodexAppServerTranslateState();
    let terminalFailure: string | null = null;
    try {
      const { events } = await session.thread.compactStreamed();
      for await (const event of events) {
        if (event.type !== 'server.notification') continue;
        session.runtimeIdentity = event.runtimeIdentity;
        terminalFailure =
          readTerminalError(event.notification)?.message ?? terminalFailure;
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
        this.emit(session, 'message', {
          role: 'system',
          text: `Codex 上下文压缩失败：${terminalFailure}`,
          error: true,
          sessionCommandStatus: { command: 'compact', status: 'failed' },
        });
      } else {
        this.emit(session, 'message', {
          role: 'system',
          text: 'Codex 上下文压缩完成。',
          sessionCommandStatus: { command: 'compact', status: 'completed' },
        });
      }
    } catch (error) {
      clearCodexLiveTokenEstimateCore(
        session,
        session.applicationSid,
        Date.now(),
        this.context.runtimeHost.liveRate,
      );
      if (controller.signal.aborted) {
        this.emit(session, 'message', {
          role: 'system',
          text: 'Codex 上下文压缩失败：操作已中断。',
          error: true,
          sessionCommandStatus: { command: 'compact', status: 'failed' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.emit(session, 'message', {
        role: 'system',
        text: `Codex 上下文压缩失败：${message}`,
        error: true,
        sessionCommandStatus: { command: 'compact', status: 'failed' },
      });
    } finally {
      session.currentTurn = null;
      session.currentTurnId = null;
    }
  }

  private release(session: InternalSession): void {
    session.activeControlCommand = null;
    session.turnLoopRunning = false;
    if (
      this.context.sessions.get(session.applicationSid) === session &&
      !session.intentionallyClosed &&
      session.pendingMessages.length > 0
    ) {
      void this.context.runTurnLoop(session, session.applicationSid);
    }
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
