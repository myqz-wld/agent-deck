import type { AgentEnqueueOptions } from '@main/adapters/types';
import { guardHandOffSourceIngress } from '@main/session/hand-off/ingress-guard';
import { worktreeToolInvocationRegistry } from '@main/session/worktree-transition/tool-invocation-registry';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';

interface GrokMessageControllerContext {
  emit: (event: AgentEvent) => void;
  dispatch: (
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
    forceQueue?: boolean,
  ) => Promise<void>;
  steer: (sessionId: string, text: string) => Promise<void>;
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
      worktreeToolInvocationRegistry.hasPendingTransition(sessionId),
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

  async steerTurn(sessionId: string, text: string): Promise<void> {
    if (this.guard(sessionId, text, undefined, undefined)) return;
    if (worktreeToolInvocationRegistry.hasPendingTransition(sessionId)) {
      await this.context.dispatch(sessionId, text, undefined, undefined, true);
      return;
    }
    await this.context.steer(sessionId, text);
  }

  private guard(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): boolean {
    return guardHandOffSourceIngress({
      sourceSessionId: sessionId,
      agentId: 'grok-build',
      text,
      attachments,
      emit: this.context.emit,
      replay: (sourceSessionId) =>
        this.context.dispatch(
          sourceSessionId,
          text,
          attachments,
          options,
          true,
        ),
      bypassWorktreeTransition:
        options?.bypassWorktreeTransitionGuard === true,
    });
  }
}
