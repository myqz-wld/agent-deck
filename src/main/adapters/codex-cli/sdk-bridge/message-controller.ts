/** Codex user-message queueing, active-turn steering, and interruption control. */
import type { UploadedAttachmentRef } from '@shared/types';
import { AGENT_ID, MAX_MESSAGE_LENGTH, MAX_PENDING_MESSAGES } from './constants';
import { packCodexInput, toCodexAppServerInput } from './input-pack';
import type { CodexBridgeOptions, InternalSession } from './types';
import log from '@main/utils/logger';

const logger = log.scope('codex-bridge');

export interface MessageControllerContext {
  sessions: ReadonlyMap<string, InternalSession>;
  emit: CodexBridgeOptions['emit'];
  recoverAndSend: (
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ) => Promise<unknown>;
  runTurnLoop: (session: InternalSession, sessionId: string) => Promise<void>;
}

export class MessageController {
  constructor(private readonly ctx: MessageControllerContext) {}

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    const session = this.ctx.sessions.get(sessionId);
    if (!session) {
      await this.ctx.recoverAndSend(sessionId, text, attachments);
      return;
    }

    const length = text.length;
    if (length > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `单条消息 ${length.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简或拆分发送。`,
      );
    }

    if (!attachments?.length && session.currentTurn && session.currentTurnId) {
      await this.steerActiveTurn(session, sessionId, text, session.currentTurnId);
      return;
    }

    if (session.pendingMessages.length >= MAX_PENDING_MESSAGES) {
      throw new Error(`待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条。请等当前 turn 跑完再继续发送。`);
    }

    session.pendingMessages.push(packCodexInput(text, attachments));
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text,
        role: 'user',
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });

    if (!session.turnLoopRunning) {
      void this.ctx.runTurnLoop(session, sessionId);
    }
  }

  async steerTurn(sessionId: string, text: string): Promise<void> {
    const session = this.ctx.sessions.get(sessionId);
    if (!session) throw new Error('Codex 会话不在运行中，无法 mid-turn steer。');

    const length = text.length;
    if (length > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `单条 steer ${length.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简后再发送。`,
      );
    }
    if (!session.currentTurn || !session.currentTurnId) {
      throw new Error('Codex 当前没有可 steer 的 active turn。');
    }
    await this.steerActiveTurn(session, sessionId, text, session.currentTurnId);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.ctx.sessions.get(sessionId);
    if (!session?.currentTurn) return;
    try {
      session.currentTurn.abort();
    } catch (err) {
      logger.warn('[codex-bridge] interrupt failed', err);
    }
  }

  private async steerActiveTurn(
    session: InternalSession,
    sessionId: string,
    text: string,
    expectedTurnId: string,
  ): Promise<void> {
    await session.thread.steer(toCodexAppServerInput(packCodexInput(text)), expectedTurnId);
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text, role: 'user', steer: true },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}
