import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { promises as fsp } from 'node:fs';
import type { UploadedAttachmentRef } from '@shared/types';
import type { InternalSession, PendingUserMessage, SdkBridgeOptions } from './types';

export interface ClaudeUserMessageStreamContext {
  readonly sessions: ReadonlyMap<string, InternalSession>;
  readonly emit: SdkBridgeOptions['emit'];
}

/** Build a lazy SDK message so queued image base64 never stays resident before consumption. */
export function makeClaudeUserMessage(
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
): PendingUserMessage {
  const handOffMessage = {
    text,
    ...(attachments && attachments.length > 0
      ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
  const retainForHandOff = (
    materialize: () => Promise<SDKUserMessage>,
  ): PendingUserMessage => Object.assign(materialize, { handOffMessage });
  if (!attachments || attachments.length === 0) {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      priority: 'now',
      session_id: sessionId,
    };
    return retainForHandOff(() => Promise.resolve(message));
  }
  return retainForHandOff(async () => {
    type ClaudeImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    const blocks: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: { type: 'base64'; media_type: ClaudeImageMime; data: string };
        }
    > = [];
    for (const ref of attachments) {
      const buffer = await fsp.readFile(ref.path);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: ref.mime as ClaudeImageMime,
          data: buffer.toString('base64'),
        },
      });
    }
    if (text.length > 0) blocks.push({ type: 'text', text });
    return {
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
      priority: 'now',
      session_id: sessionId,
    };
  });
}

/** Serialize provider input and retain deferred composer turns until their true dequeue boundary. */
export async function* createClaudeUserMessageStream(
  ctx: ClaudeUserMessageStreamContext,
  internal: InternalSession,
): AsyncIterable<SDKUserMessage> {
  while (true) {
    if (internal.retireBoundaryReached) return;
    if (
      !internal.retireRequested &&
      !internal.userTurnInFlight &&
      internal.pendingUserMessages.length > 0 &&
      !internal.pendingUserMessages[0]?.materializationError
    ) {
      // Keep the thunk authoritative while image I/O is in flight. Deletion can still win until
      // the same object is removed from the head immediately before the provider-facing yield.
      const thunk = internal.pendingUserMessages[0]!;
      let message: SDKUserMessage;
      try {
        message = await thunk();
      } catch (error) {
        if (!thunk.deferredUserEvent?.turnCorrelationId) throw error;
        thunk.materializationError = error instanceof Error ? error.message : String(error);
        ctx.emit({
          sessionId: internal.applicationSid,
          agentId: 'claude-code',
          kind: 'message',
          payload: {
            text: `⚠ 等待消息的附件读取失败，消息仍在等待队列中，可删除后重新发送：${thunk.materializationError}`,
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        continue;
      }
      if (internal.pendingUserMessages[0] !== thunk) continue;
      internal.pendingUserMessages.shift();
      if (internal.retireBoundaryReached) return;
      if (internal.retireRequested) continue;
      if (thunk.deferredUserEvent) {
        ctx.emit({
          sessionId: internal.applicationSid,
          agentId: 'claude-code',
          kind: 'message',
          payload: {
            text: thunk.deferredUserEvent.text,
            role: 'user',
            ...(thunk.deferredUserEvent.attachments?.length
              ? { attachments: thunk.deferredUserEvent.attachments }
              : {}),
            ...(thunk.deferredUserEvent.turnCorrelationId
              ? { turnCorrelationId: thunk.deferredUserEvent.turnCorrelationId }
              : {}),
          },
          ts: Date.now(),
          source: 'sdk',
        });
      }
      internal.userTurnInFlight = true;
      yield message;
      continue;
    }
    await new Promise<void>((resolve) => {
      internal.notify = resolve;
    });
    internal.notify = null;
    if (internal.retireBoundaryReached) return;
    if (ctx.sessions.get(internal.applicationSid) !== internal) return;
  }
}
