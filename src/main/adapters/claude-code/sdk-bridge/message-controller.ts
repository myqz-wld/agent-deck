import type { UploadedAttachmentRef } from '@shared/types';
import { bufferHandOffSourceInput } from '@main/session/hand-off/input-buffer';
import {
  validateMessageLengthOrThrow,
  validateSendMessageOrThrow,
  validateSessionAcceptsMessageOrThrow,
} from './send-validation';
import type {
  InternalSession,
  PendingUserMessage,
  SdkBridgeOptions,
} from './types';

interface PersistedRecoveryOptions {
  userEventAlreadyPersisted?: boolean;
  sendAfterRecovery?: (sessionId: string) => Promise<void>;
}

export interface ClaudeMessageControllerContext {
  sessions: ReadonlyMap<string, InternalSession>;
  emit: SdkBridgeOptions['emit'];
  recoverAndSend: (
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: PersistedRecoveryOptions,
  ) => Promise<unknown>;
  makeUserMessage: (
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ) => PendingUserMessage;
}

async function enqueuePersistedMessage(
  ctx: ClaudeMessageControllerContext,
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
): Promise<void> {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    await ctx.recoverAndSend(sessionId, text, attachments, {
      userEventAlreadyPersisted: true,
      sendAfterRecovery: (recoveredSessionId) =>
        enqueuePersistedMessage(ctx, recoveredSessionId, text, attachments),
    });
    return;
  }
  validateSessionAcceptsMessageOrThrow(session, sessionId);
  session.pendingUserMessages.push(ctx.makeUserMessage(sessionId, text, attachments));
  session.notify?.();
}

/** Queue ordinary Claude input, or divert it into an active handoff with rollback replay. */
export async function sendClaudeMessage(
  ctx: ClaudeMessageControllerContext,
  input: {
    sessionId: string;
    text: string;
    attachments?: UploadedAttachmentRef[];
    allowQueueOverflow?: boolean;
  },
): Promise<void> {
  validateMessageLengthOrThrow(input.text);
  if (
    bufferHandOffSourceInput({
      sourceSessionId: input.sessionId,
      agentId: 'claude-code',
      text: input.text,
      attachments: input.attachments,
      emit: ctx.emit,
      replay: (sourceSessionId) =>
        enqueuePersistedMessage(
          ctx,
          sourceSessionId,
          input.text,
          input.attachments,
        ),
    })
  ) {
    return;
  }

  const session = ctx.sessions.get(input.sessionId);
  if (!session) {
    await ctx.recoverAndSend(input.sessionId, input.text, input.attachments);
    return;
  }
  validateSendMessageOrThrow(
    session,
    input.sessionId,
    input.text,
    ctx.emit,
    input.allowQueueOverflow,
  );
  session.pendingUserMessages.push(
    ctx.makeUserMessage(input.sessionId, input.text, input.attachments),
  );
  session.notify?.();
  ctx.emit({
    sessionId: input.sessionId,
    agentId: 'claude-code',
    kind: 'message',
    payload: {
      text: input.text,
      role: 'user',
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    },
    ts: Date.now(),
    source: 'sdk',
  });
}
