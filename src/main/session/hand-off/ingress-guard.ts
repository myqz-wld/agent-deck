import type { AgentEvent, SessionAdapterId, UploadedAttachmentRef } from '@shared/types';
import { bufferHandOffSourceInput } from './input-buffer';
import { guardWorktreeTransitionIngress } from '../worktree-transition/ingress-guard';

/**
 * Adapter-neutral source-ingress contract. Every adapter send/enqueue consumer must call this
 * before resolving live runtime state, recovering a session, steering, or appending a provider
 * queue. Grok Build can adopt the same contract without changing cutover semantics.
 */
export interface HandOffIngressGuardInput {
  sourceSessionId: string;
  agentId: SessionAdapterId;
  text: string;
  attachments?: UploadedAttachmentRef[];
  emit: (event: AgentEvent) => void;
  replay: (sourceSessionId: string) => Promise<void>;
  bypassWorktreeTransition?: boolean;
}

/** True means the cutover lease durably accepted the input and provider ingress must stop here. */
export function guardHandOffSourceIngress(input: HandOffIngressGuardInput): boolean {
  if (
    input.bypassWorktreeTransition !== true &&
    guardWorktreeTransitionIngress({
      sessionId: input.sourceSessionId,
      agentId: input.agentId,
      text: input.text,
      attachments: input.attachments,
      emit: input.emit,
    })
  ) {
    return true;
  }
  return bufferHandOffSourceInput(input);
}
