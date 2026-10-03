import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UploadedAttachmentRef } from '@shared/types';
import type { InternalSession, PendingUserMessage, SdkBridgeOptions } from './types';

export interface ClaudeUserMessageStreamContext {
  readonly sessions: ReadonlyMap<string, InternalSession>;
  readonly emit: SdkBridgeOptions['emit'];
}

export interface ClaudeUserMessageStreamHost {
  readAttachmentBase64(path: string): Promise<string>;
  createProviderMessageId(): string;
  /** Must be best-effort: Browser renewal cannot reject an otherwise valid provider turn. */
  refreshBrowserRuntime?(applicationSessionId: string): void;
  now(): number;
}

/** Build a lazy SDK message so queued image base64 never stays resident before consumption. */
export function makeClaudeUserMessageCore(
  sessionId: string,
  text: string,
  attachments: UploadedAttachmentRef[] | undefined,
  host: ClaudeUserMessageStreamHost,
  handOffText = text,
): PendingUserMessage {
  const handOffMessage = {
    text: handOffText,
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
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: ref.mime as ClaudeImageMime,
          data: await host.readAttachmentBase64(ref.path),
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

/** Stream composer corrections mid-turn, with at most one input awaiting provider acceptance. */
export async function* createClaudeUserMessageStreamCore(
  ctx: ClaudeUserMessageStreamContext,
  internal: InternalSession,
  host: ClaudeUserMessageStreamHost,
): AsyncIterable<SDKUserMessage> {
  while (true) {
    if (internal.providerInputClosed || internal.retireBoundaryReached) return;
    if (
      !internal.retireRequested &&
      internal.cwdTransitionGeneration == null &&
      !internal.submittingUserMessage &&
      (!internal.userTurnInFlight || internal.pendingUserMessages[0]?.deferredUserEvent) &&
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
          ts: host.now(),
          source: 'sdk',
        });
        continue;
      }
      if (internal.providerInputClosed || internal.retireBoundaryReached) return;
      if (internal.pendingUserMessages[0] !== thunk) continue;
      if (internal.retireRequested || internal.cwdTransitionGeneration != null) continue;
      host.refreshBrowserRuntime?.(internal.applicationSid);
      internal.pendingUserMessages.shift();
      const providerMessageId = thunk.deferredUserEvent
        ? thunk.deferredUserEvent.turnCorrelationId ?? host.createProviderMessageId()
        : null;
      if (providerMessageId) {
        message.uuid = providerMessageId as NonNullable<SDKUserMessage['uuid']>;
        internal.submittingUserMessage = {
          pending: thunk,
          providerMessageId,
          status: 'submitting',
          ...(internal.userTurnInFlight ? { precedingTurn: 'active' as const } : {}),
        };
      }
      internal.userTurnInFlight = true;
      yield message;
      continue;
    }
    await new Promise<void>((resolve) => {
      internal.notify = resolve;
    });
    internal.notify = null;
    if (internal.providerInputClosed || internal.retireBoundaryReached) return;
    if (ctx.sessions.get(internal.applicationSid) !== internal) return;
  }
}
