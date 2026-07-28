/** Ordinary adapter sending plus authoritative pending-outgoing queue IPC. */
import { randomUUID } from 'node:crypto';
import { adapterRegistry } from '@main/adapters/registry';
import {
  deleteUploadIfExists,
  loadUploadedImage,
} from '@main/store/image-uploads';
import { IpcInvoke } from '@shared/ipc-channels';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import type { PendingOutgoingAttachmentLoadResult } from '@shared/types';
import { IpcInputError, on, parseStringId } from './_helpers';
import { persistAdapterAttachments } from './adapters-attachments';
import { dispatchAdapterMessageWithHandOffRedirect } from './adapters-message-dispatch';
import log from '@main/utils/logger';
import { safeErrorSummary } from '@main/utils/safe-diagnostic';

const logger = log.scope('adapter-outgoing-ipc');

function pendingAttachmentId(index: number): string {
  return String(index);
}

function pendingAttachmentNotFound(): PendingOutgoingAttachmentLoadResult {
  return { ok: false, reason: 'not_found' };
}

export function registerAdapterOutgoingIpc(): void {
  on(IpcInvoke.AdapterSendMessage, async (_e, agentId, sessionId, payload) => {
    const parsedAgentId = parseStringId('agentId', agentId, 64);
    const adapter = adapterRegistry.get(parsedAgentId);
    if (!adapter?.sendMessage) throw new Error('adapter cannot send message');
    let text: string;
    let rawAttachments: unknown;
    if (typeof payload === 'string') {
      text = payload;
    } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const env = payload as { text?: unknown; attachments?: unknown };
      if (typeof env.text !== 'string') {
        throw new IpcInputError('payload.text', 'must be string');
      }
      text = env.text;
      rawAttachments = env.attachments;
    } else {
      throw new IpcInputError('payload', 'must be string or {text, attachments?}');
    }
    if (text.length > MAX_USER_MESSAGE_LENGTH) {
      throw new IpcInputError('text', `> 102400 chars (got ${text.length.toLocaleString()} chars)`);
    }
    if (
      rawAttachments &&
      Array.isArray(rawAttachments) &&
      rawAttachments.length > 0 &&
      !adapter.capabilities.canAcceptAttachments
    ) {
      throw new IpcInputError(
        'attachments',
        `adapter "${agentId}" does not support attachments`,
      );
    }
    const attachments = await persistAdapterAttachments(rawAttachments, 'attachments');
    const sourceSessionId = parseStringId('sessionId', sessionId);
    const messageId = randomUUID();
    try {
      const targetSessionId = await dispatchAdapterMessageWithHandOffRedirect({
        sourceSessionId,
        sourceAdapter: adapter,
        text,
        attachments,
        sendOptions: {
          deferUserEventUntilTurnStart: true,
          turnCorrelationId: messageId,
        },
      });
      return { messageId, sessionId: targetSessionId };
    } catch (error) {
      const cleanup = await Promise.allSettled(
        attachments.map((attachment) => deleteUploadIfExists(attachment.path)),
      );
      for (const result of cleanup) {
        if (result.status === 'fulfilled') continue;
        logger.warn('send attachment cleanup failed', {
          agentId: parsedAgentId,
          sessionId: sourceSessionId,
          messageId,
          action: 'send-cleanup',
          error: safeErrorSummary(result.reason),
        });
      }
      throw error;
    }
  });

  on(IpcInvoke.AdapterListPendingOutgoing, (_e, agentId, sessionId) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter) throw new Error('adapter not found');
    const sid = parseStringId('sessionId', sessionId);
    return (adapter.listPendingOutgoingMessages?.(sid) ?? []).map((message) => ({
      id: message.id,
      text: message.text,
      attachments: (message.attachments ?? []).map((attachment, index) => ({
        id: pendingAttachmentId(index),
        mime: attachment.mime,
        bytes: attachment.bytes,
      })),
    }));
  });

  on(
    IpcInvoke.AdapterLoadPendingOutgoingAttachment,
    async (_e, agentId, sessionId, messageId, attachmentId) => {
      const parsedAgentId = parseStringId('agentId', agentId, 64);
      const adapter = adapterRegistry.get(parsedAgentId);
      if (!adapter) throw new Error('adapter not found');
      const sid = parseStringId('sessionId', sessionId);
      const id = parseStringId('messageId', messageId, 128);
      const slotId = parseStringId('attachmentId', attachmentId, 32);
      const message = (adapter.listPendingOutgoingMessages?.(sid) ?? [])
        .find((candidate) => candidate.id === id);
      const attachment = message?.attachments?.find(
        (_candidate, index) => pendingAttachmentId(index) === slotId,
      );
      if (!attachment) return pendingAttachmentNotFound();
      try {
        const result = await loadUploadedImage(attachment.path);
        return result.ok ? result : { ok: false, reason: result.reason };
      } catch (error) {
        logger.warn('pending attachment load failed', {
          agentId: parsedAgentId,
          sessionId: sid,
          messageId: id,
          action: 'load-attachment',
          error: safeErrorSummary(error),
        });
        return {
          ok: false,
          reason: 'io_error',
        } satisfies PendingOutgoingAttachmentLoadResult;
      }
    },
  );

  on(IpcInvoke.AdapterDeletePendingOutgoing, async (_e, agentId, sessionId, messageId) => {
    const parsedAgentId = parseStringId('agentId', agentId, 64);
    const adapter = adapterRegistry.get(parsedAgentId);
    if (!adapter) throw new Error('adapter not found');
    const sid = parseStringId('sessionId', sessionId);
    const id = parseStringId('messageId', messageId, 128);
    const removed = await (adapter.removePendingOutgoingMessage?.(sid, id) ?? null);
    if (!removed) return false;
    const cleanup = await Promise.allSettled((removed.attachments ?? []).map((attachment) =>
      deleteUploadIfExists(attachment.path)));
    for (const result of cleanup) {
      if (result.status === 'fulfilled') continue;
      logger.warn('pending attachment cleanup failed', {
        agentId: parsedAgentId,
        sessionId: sid,
        messageId: id,
        action: 'delete-cleanup',
        error: safeErrorSummary(result.reason),
      });
    }
    return true;
  });
}
