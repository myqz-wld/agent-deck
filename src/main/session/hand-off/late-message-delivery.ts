import { adapterRegistry } from '@main/adapters/registry';
import type { AgentAdapter } from '@main/adapters/types';
import type { CreateSessionOptions } from '@main/adapters/types';
import {
  deleteUploadIfExists,
  loadUploadedImage,
  writeUploadedImage,
} from '@main/store/image-uploads';
import type { UploadedAttachmentInput, UploadedAttachmentRef } from '@shared/types';
import type { HandOffLateMessage } from './source-precondition';

export interface DeliverHandOffLateMessagesInput {
  successorSessionId: string;
  target: CreateSessionOptions;
  messages: HandOffLateMessage[];
}

export interface HandOffLateMessageDeliveryDeps {
  getAdapter: (agentId: CreateSessionOptions['agentId']) => AgentAdapter | undefined;
  loadAttachment: typeof loadUploadedImage;
  writeAttachment: typeof writeUploadedImage;
}

export class HandOffLateMessageDeliveryError extends Error {
  constructor(
    message: string,
    readonly createdAttachments: UploadedAttachmentRef[],
  ) {
    super(message);
    this.name = 'HandOffLateMessageDeliveryError';
  }
}

export async function cleanupHandOffLateMessageAttachments(
  attachments: UploadedAttachmentRef[],
): Promise<void> {
  await Promise.all(attachments.map((attachment) => deleteUploadIfExists(attachment.path)));
}

function productionDeps(): HandOffLateMessageDeliveryDeps {
  return {
    getAdapter: (agentId) => adapterRegistry.get(agentId),
    loadAttachment: loadUploadedImage,
    writeAttachment: writeUploadedImage,
  };
}

async function cloneAttachment(
  attachment: UploadedAttachmentRef,
  deps: HandOffLateMessageDeliveryDeps,
): Promise<UploadedAttachmentRef> {
  const loaded = await deps.loadAttachment(attachment.path);
  if (!loaded.ok) {
    throw new Error(`late handoff attachment cannot be read: ${loaded.reason}`);
  }
  if (loaded.bytes !== attachment.bytes || loaded.mime !== attachment.mime) {
    throw new Error('late handoff attachment changed after the source message was persisted');
  }
  const marker = ';base64,';
  const markerIndex = loaded.dataUrl.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error('late handoff attachment loader returned an invalid data URL');
  }
  const input: UploadedAttachmentInput = {
    kind: 'image',
    base64: loaded.dataUrl.slice(markerIndex + marker.length),
    mime: loaded.mime,
    bytes: loaded.bytes,
  };
  return deps.writeAttachment(input);
}

async function cloneAttachments(
  attachments: UploadedAttachmentRef[],
  deps: HandOffLateMessageDeliveryDeps,
  createdAttachments: UploadedAttachmentRef[],
): Promise<UploadedAttachmentRef[]> {
  const cloned: UploadedAttachmentRef[] = [];
  for (const attachment of attachments) {
    const copy = await cloneAttachment(attachment, deps);
    cloned.push(copy);
    createdAttachments.push(copy);
  }
  return cloned;
}

/** Queue each late source input behind the prepared turn before source ownership moves. */
export async function deliverHandOffLateMessages(
  input: DeliverHandOffLateMessagesInput,
  deps: HandOffLateMessageDeliveryDeps = productionDeps(),
): Promise<UploadedAttachmentRef[]> {
  if (input.messages.length === 0) return [];
  const adapter = deps.getAdapter(input.target.agentId);
  if (!adapter?.enqueueMessage) {
    throw new Error(`adapter "${input.target.agentId}" cannot queue late handoff messages`);
  }
  const createdAttachments: UploadedAttachmentRef[] = [];
  try {
    for (const message of input.messages) {
      const attachments = await cloneAttachments(
        message.attachments,
        deps,
        createdAttachments,
      );
      await adapter.enqueueMessage(
        input.successorSessionId,
        message.text,
        attachments.length > 0 ? attachments : undefined,
        { bypassQueueLimit: true },
      );
    }
    return createdAttachments;
  } catch (error) {
    throw new HandOffLateMessageDeliveryError(
      error instanceof Error ? error.message : String(error),
      createdAttachments,
    );
  }
}
