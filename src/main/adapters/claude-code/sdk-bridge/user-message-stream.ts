import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UploadedAttachmentRef } from '@shared/types';
import {
  createClaudeUserMessageStreamCore,
  makeClaudeUserMessageCore,
  type ClaudeUserMessageStreamContext,
} from './user-message-stream-core';
import { desktopClaudeUserMessageStreamHost } from './user-message-stream-host';
import type { InternalSession, PendingUserMessage } from './types';

export type { ClaudeUserMessageStreamContext } from './user-message-stream-core';

export function makeClaudeUserMessage(
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
): PendingUserMessage {
  return makeClaudeUserMessageCore(
    sessionId,
    text,
    attachments,
    desktopClaudeUserMessageStreamHost,
  );
}

export function createClaudeUserMessageStream(
  ctx: ClaudeUserMessageStreamContext,
  internal: InternalSession,
): AsyncIterable<SDKUserMessage> {
  return createClaudeUserMessageStreamCore(ctx, internal, desktopClaudeUserMessageStreamHost);
}
