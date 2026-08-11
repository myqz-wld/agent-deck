import type { AgentEnqueueOptions } from '@main/adapters/types';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import type { GrokBridgeRuntimeHost } from './bridge-runtime-core';

interface GrokMessageControllerContext {
  runtimeHost: Pick<
    GrokBridgeRuntimeHost,
    'guardHandOffSourceIngress' | 'hasPendingWorktreeTransition'
  >;
  emit: (event: AgentEvent) => void;
  dispatch: (
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
    forceQueue?: boolean,
  ) => Promise<void>;
  steer: (
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ) => Promise<void>;
}

/** Applies the shared cutover gate before any Grok runtime lookup or provider mutation. */
export class GrokMessageController {
  constructor(private readonly context: GrokMessageControllerContext) {}

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    if (this.guard(sessionId, text, attachments, options)) return;
    await this.context.dispatch(
      sessionId,
      text,
      attachments,
      options,
      this.context.runtimeHost.hasPendingWorktreeTransition(sessionId),
    );
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    if (this.guard(sessionId, text, attachments, options)) return;
    await this.context.dispatch(sessionId, text, attachments, options, true);
  }

  async steerTurn(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    if (this.guard(sessionId, text, attachments, undefined)) return;
    if (this.context.runtimeHost.hasPendingWorktreeTransition(sessionId)) {
      await this.context.dispatch(sessionId, text, attachments, undefined, true);
      return;
    }
    await this.context.steer(sessionId, text, attachments);
  }

  private guard(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): boolean {
    return this.context.runtimeHost.guardHandOffSourceIngress({
      sourceSessionId: sessionId,
      text,
      attachments,
      emit: this.context.emit,
      replay: (sourceSessionId) =>
        this.context.dispatch(
          sourceSessionId,
          text,
          attachments,
          { ...options, userEventAlreadyPersisted: true },
          true,
        ),
      bypassWorktreeTransition:
        options?.bypassWorktreeTransitionGuard === true,
    });
  }
}
