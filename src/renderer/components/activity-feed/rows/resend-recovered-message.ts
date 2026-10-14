import type { UploadedAttachmentInput } from '@shared/types';
import type { MessageDeliveryRecovery } from '@shared/message-delivery-recovery';
import { useSessionStore } from '@renderer/stores/session-store';

/** Resubmit only an owner's explicit action, through ordinary validated sending and recovery. */
export async function resendRecoveredLocalMessage(
  agentId: string,
  sessionId: string,
  recovery: MessageDeliveryRecovery,
): Promise<void> {
  if (recovery.textTruncated) throw new Error('原文不完整，无法直接重新发送。');
  if (recovery.attachments.length !== recovery.attachmentCount) {
    throw new Error('附件记录不完整，请重新添加图片后发送。');
  }
  const attachments: UploadedAttachmentInput[] = [];
  for (const [index, attachment] of recovery.attachments.entries()) {
    const result = await window.api.loadUploadedImage(attachment.path);
    if (!result.ok || !/^data:[^;]+;base64,/.test(result.dataUrl)) {
      throw new Error(`第 ${index + 1} 个附件无法读取，请重新添加图片后发送。`);
    }
    attachments.push({ kind: 'image', base64: result.dataUrl.slice(result.dataUrl.indexOf(',') + 1),
      mime: result.mime, bytes: result.bytes });
  }
  const sent = await window.api.sendAdapterMessage(agentId, sessionId, {
    text: recovery.text,
    ...(attachments.length ? { attachments } : {}),
  });
  // Refresh the queue without replacing a draft the owner may already be writing.
  try {
    const store = useSessionStore.getState();
    for (const id of new Set([sessionId, sent.sessionId])) {
      store.updateComposer(id, (current) => ({ ...current,
        queueRefreshVersion: current.queueRefreshVersion + 1 }));
    }
  } catch {
    // Presentation failure cannot revoke a successful enqueue or invite an accidental resend.
  }
}
