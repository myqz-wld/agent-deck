import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PendingAgentMessage } from '@main/adapters/types';
import type { UploadedAttachmentRef } from '@shared/types';

import { errorText } from './protocol-utils';
import type { GrokPendingMessage, GrokRuntime, GrokSubmittingMessage } from './runtime-types';

export function isCancelled(submitting: GrokSubmittingMessage | null): boolean {
  return submitting?.status === 'cancelled';
}

export function toPendingAgentMessage(message: GrokPendingMessage): PendingAgentMessage {
  return {
    id: pendingMessageId(message),
    text: message.text,
    ...(message.attachments?.length
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
}

export function pendingMessageId(message: GrokPendingMessage): string {
  return message.turnCorrelationId ?? message.id;
}

export function supportsImages(runtime: GrokRuntime): boolean {
  if (!runtime.ready) return true;
  return (
    runtime.process?.initializeResponse.agentCapabilities?.promptCapabilities?.image === true
  );
}

export function isInterjectionUnsupported(error: unknown): boolean {
  const candidate = error as { code?: unknown } | null;
  return candidate?.code === -32601 || /method not found/i.test(errorText(error));
}

export function requireNativeSession(runtime: GrokRuntime): string {
  if (!runtime.nativeSessionId) {
    throw new Error(
      `Grok Build 会话 ${runtime.applicationSessionId} 缺少原生会话 ID。`,
    );
  }
  return runtime.nativeSessionId;
}

export async function promptBlocks(
  text: string,
  attachments?: UploadedAttachmentRef[],
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const attachment of attachments ?? []) {
    blocks.push({
      type: 'image',
      data: (await readFile(attachment.path)).toString('base64'),
      mimeType: attachment.mime,
      uri: pathToFileURL(attachment.path).href,
    });
  }
  return blocks;
}
