import type { AgentEvent, UploadedAttachmentRef } from './types';

export type MessageDeliveryRecoveryStatus = 'unknown' | 'not-sent';

export interface MessageDeliveryRecovery {
  status: MessageDeliveryRecoveryStatus;
  messageId: string | null;
  text: string;
  attachmentCount: number;
  textTruncated: boolean;
  attachments: UploadedAttachmentRef[];
}

/** Recovery records are system events, never proof that the provider accepted a user turn. */
export function readMessageDeliveryRecovery(event: AgentEvent): MessageDeliveryRecovery | null {
  if (event.kind !== 'message' || !event.payload || typeof event.payload !== 'object') return null;
  return readMessageDeliveryRecoveryPayload(event.payload);
}

export function readMessageDeliveryRecoveryPayload(value: unknown): MessageDeliveryRecovery | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (payload.role !== 'system' || payload.error !== true || typeof payload.text !== 'string') return null;
  const metadata = payload.messageDeliveryRecovery;
  if (!metadata || typeof metadata !== 'object') return null;
  const recovery = metadata as Record<string, unknown>;
  if (recovery.status !== 'unknown' && recovery.status !== 'not-sent') return null;
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.filter((value): value is UploadedAttachmentRef => {
      if (!value || typeof value !== 'object') return false;
      return value.kind === 'uploaded' && typeof value.path === 'string'
        && typeof value.mime === 'string' && typeof value.bytes === 'number';
    }) : [];
  return {
    status: recovery.status,
    messageId: typeof recovery.messageId === 'string' ? recovery.messageId : null,
    text: payload.text,
    textTruncated: typeof recovery.originalTextLength === 'number'
      && recovery.originalTextLength > payload.text.length,
    attachmentCount: typeof recovery.attachmentCount === 'number'
      && Number.isSafeInteger(recovery.attachmentCount) && recovery.attachmentCount >= 0
      ? recovery.attachmentCount : attachments.length,
    attachments,
  };
}
