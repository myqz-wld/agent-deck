/** Ordinary adapter sending plus authoritative pending-outgoing queue IPC. */
import { randomUUID } from 'node:crypto';
import { adapterRegistry } from '@main/adapters/registry';
import { deleteUploadIfExists } from '@main/store/image-uploads';
import { IpcInvoke } from '@shared/ipc-channels';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { IpcInputError, on, parseStringId } from './_helpers';
import { persistAdapterAttachments } from './adapters-attachments';
import { dispatchAdapterMessageWithHandOffRedirect } from './adapters-message-dispatch';
import log from '@main/utils/logger';

const logger = log.scope('adapter-outgoing-ipc');

export function registerAdapterOutgoingIpc(): void {
  on(IpcInvoke.AdapterSendMessage, async (_e, agentId, sessionId, payload) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
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
      await Promise.all(attachments.map((attachment) => deleteUploadIfExists(attachment.path)));
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
      attachmentCount: message.attachments?.length ?? 0,
    }));
  });

  on(IpcInvoke.AdapterDeletePendingOutgoing, async (_e, agentId, sessionId, messageId) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter) throw new Error('adapter not found');
    const sid = parseStringId('sessionId', sessionId);
    const id = parseStringId('messageId', messageId, 128);
    const removed = adapter.removePendingOutgoingMessage?.(sid, id) ?? null;
    if (!removed) return false;
    const cleanup = await Promise.allSettled((removed.attachments ?? []).map((attachment) =>
      deleteUploadIfExists(attachment.path)));
    for (const [index, result] of cleanup.entries()) {
      if (result.status === 'fulfilled') continue;
      logger.warn(
        `[adapter-outgoing] queued message was removed but upload cleanup failed: ${removed.attachments?.[index]?.path ?? 'unknown'}`,
        result.reason,
      );
    }
    return true;
  });
}
