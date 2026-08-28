import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import {
  translateSdkMessageCore,
  type ClaudeSdkMessageTranslationHost,
} from './sdk-message-translate-core';
import { finalizeClaudeStreamCore, type ClaudeStreamFinalizeHost } from './stream-finalize-core';
import {
  adoptClaudeStreamFirstIdCore,
  type ClaudeStreamResumeMode,
  type ClaudeStreamSessionIdentityHost,
} from './stream-session-identity-core';
import {
  waitForClaudeStreamIdCore,
  type ClaudeStreamWaitHost,
} from './stream-wait-core';
import { observeClaudeTrustedContinuationFrame } from './trusted-continuation-observer';
import type { InternalSession, PendingUserMessage } from './types';
import {
  createClaudeUserMessageStreamCore,
  makeClaudeUserMessageCore,
  type ClaudeUserMessageStreamHost,
} from './user-message-stream-core';
import { applyClaudeConversationResetCore } from './conversation-reset-core';

export interface ClaudeStreamProcessorContext {
  readonly sessions: Map<string, InternalSession>;
  readonly emit: (event: AgentEvent) => void;
}

export interface ClaudeStreamProcessorHost extends ClaudeStreamWaitHost {
  readonly userMessages: ClaudeUserMessageStreamHost;
  readonly translation: ClaudeSdkMessageTranslationHost;
  readonly finalize: ClaudeStreamFinalizeHost;
  readonly identity: ClaudeStreamSessionIdentityHost;
}

/** Own the provider stream loop without importing desktop repositories, event buses, or logging. */
export class ClaudeStreamProcessorCore {
  constructor(
    private readonly ctx: ClaudeStreamProcessorContext,
    private readonly host: ClaudeStreamProcessorHost,
  ) {}

  makeUserMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    handOffText = text,
  ): PendingUserMessage {
    return makeClaudeUserMessageCore(
      sessionId,
      text,
      attachments,
      this.host.userMessages,
      handOffText,
    );
  }

  createUserMessageStream(
    internal: InternalSession,
    _tempKey: string,
  ): AsyncIterable<SDKUserMessage> {
    return createClaudeUserMessageStreamCore(this.ctx, internal, this.host.userMessages);
  }

  waitForRealSessionId(
    internal: InternalSession,
    tempKey: string,
    resumeId?: string,
    effectiveResumeCliSid?: string,
    resumeMode?: ClaudeStreamResumeMode,
  ): Promise<string> {
    return waitForClaudeStreamIdCore(
      this.ctx,
      internal,
      tempKey,
      resumeId,
      (onFirstId) => this.consume(
        internal,
        tempKey,
        onFirstId,
        resumeId,
        effectiveResumeCliSid,
        resumeMode,
      ),
      this.host,
    );
  }

  async consume(
    internal: InternalSession,
    tempKey: string,
    onFirstId: (id: string) => void,
    applicationResumeId?: string,
    effectiveResumeCliSid?: string,
    resumeMode?: ClaudeStreamResumeMode,
  ): Promise<string | null> {
    let realId: string | null = null;
    try {
      for await (const msg of internal.query) {
        const frame = msg as { type: string; session_id?: string; [key: string]: unknown };
        observeClaudeTrustedContinuationFrame(internal, frame);

        if (!realId && typeof frame.session_id === 'string' && frame.session_id) {
          const adoptedId = adoptClaudeStreamFirstIdCore({
            sessions: this.ctx.sessions,
            internal,
            tempKey,
            incomingId: frame.session_id,
            applicationResumeId,
            effectiveResumeCliSid,
            resumeMode,
            onFirstId,
          }, this.host.identity);
          if (!adoptedId) continue;
          realId = adoptedId;
        }

        const sessionId = internal.applicationSid;
        if (frame.type === 'conversation_reset') {
          applyClaudeConversationResetCore(
            internal,
            { new_conversation_id: frame.new_conversation_id },
            this.ctx.emit,
            {
              updateCliSessionId: this.host.identity.updateCliSessionId,
              now: this.host.now,
            },
          );
          continue;
        }
        translateSdkMessageCore(
          this.ctx.emit,
          sessionId,
          frame,
          internal,
          this.host.translation,
        );
        if (frame.type === 'result') internal.userTurnInFlight = false;
        if (internal.retireRequested && frame.type === 'result') {
          internal.retireBoundaryReached = true;
          internal.expectedClose = true;
          internal.pendingUserMessages.length = 0;
          const notify = internal.notify;
          internal.notify = null;
          notify?.();
          try {
            void internal.query.interrupt().catch((error) => {
              this.host.warn(
                `[sdk-bridge] deferred handoff retirement interrupt failed: ${sessionId}`,
                error,
              );
            });
          } catch (error) {
            this.host.warn(
              `[sdk-bridge] deferred handoff retirement interrupt failed: ${sessionId}`,
              error,
            );
          }
          break;
        }
        if (frame.type === 'result') {
          const notify = internal.notify;
          internal.notify = null;
          notify?.();
        }
      }
    } catch (error) {
      this.host.warn('[sdk-bridge] query loop ended', error);
      if (!internal.expectedClose) {
        this.ctx.emit({
          sessionId: internal.applicationSid,
          agentId: this.host.agentId,
          kind: 'message',
          payload: {
            text: `⚠ SDK 流中断：${(error as Error)?.message ?? String(error)}`,
            error: true,
          },
          ts: this.host.now(),
          source: 'sdk',
        });
      }
    } finally {
      finalizeClaudeStreamCore(this.ctx, internal, tempKey, this.host.finalize);
    }
    return realId;
  }
}
