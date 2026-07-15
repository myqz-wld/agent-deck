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
import type { AgentEnqueueOptions } from '@main/adapters/types';
import {
  type AdapterRecoveryDeliveryOptions,
  enqueuePayloadFingerprint,
  isAcceptedEnqueueRetry,
  rememberAcceptedEnqueue,
} from '@main/adapters/enqueue-idempotency';
import log from '@main/utils/logger';

const logger = log.scope('claude-bridge');

export interface ClaudeMessageControllerContext {
  sessions: ReadonlyMap<string, InternalSession>;
  emit: SdkBridgeOptions['emit'];
  recoverAndSend: (
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AdapterRecoveryDeliveryOptions,
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
    enqueueOptions?: AgentEnqueueOptions;
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
    await ctx.recoverAndSend(
      input.sessionId,
      input.text,
      input.attachments,
      input.enqueueOptions
        ? {
            initialEnqueueOptions: input.enqueueOptions,
            sendAfterRecovery: (recoveredSessionId) => sendClaudeMessage(ctx, {
              ...input,
              sessionId: recoveredSessionId,
            }),
          }
        : undefined,
    );
    return;
  }
  validateSendMessageOrThrow(
    session,
    input.sessionId,
    input.text,
    ctx.emit,
    input.allowQueueOverflow,
  );
  const idempotencyKey = input.enqueueOptions?.idempotencyKey;
  const fingerprint = idempotencyKey
    ? enqueuePayloadFingerprint(input.text, input.attachments)
    : null;
  if (idempotencyKey && fingerprint) {
    const accepted = (session.acceptedEnqueueFingerprints ??= new Map());
    if (isAcceptedEnqueueRetry(accepted, idempotencyKey, fingerprint)) {
      session.notify?.();
      return;
    }
  }
  const pending = ctx.makeUserMessage(input.sessionId, input.text, input.attachments);
  if (input.enqueueOptions?.deferUserEventUntilTurnStart) {
    pending.deferredUserEvent = {
      text: input.text,
      ...(input.attachments?.length
        ? { attachments: input.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
      ...(input.enqueueOptions.turnCorrelationId
        ? { turnCorrelationId: input.enqueueOptions.turnCorrelationId }
        : {}),
    };
  }
  session.pendingUserMessages.push(pending);
  if (idempotencyKey && fingerprint) {
    rememberAcceptedEnqueue(
      session.acceptedEnqueueFingerprints!,
      idempotencyKey,
      fingerprint,
    );
  }
  session.notify?.();
  try {
    if (!input.enqueueOptions?.deferUserEventUntilTurnStart) ctx.emit({
      sessionId: input.sessionId,
      agentId: 'claude-code',
      kind: 'message',
      payload: {
        text: input.text,
        role: 'user',
        ...(input.enqueueOptions?.turnCorrelationId
          ? { turnCorrelationId: input.enqueueOptions.turnCorrelationId }
          : {}),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });
  } catch (error) {
    if (!idempotencyKey) throw error;
    logger.warn(`[claude-bridge] accepted enqueue event failed key=${idempotencyKey}`, error);
  }
}
