import type { AgentEvent, SessionAdapterId, UploadedAttachmentRef } from '@shared/types';
import { bufferHandOffSourceInput } from './input-buffer';

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
}

/** True means the cutover lease durably accepted the input and provider ingress must stop here. */
export function guardHandOffSourceIngress(input: HandOffIngressGuardInput): boolean {
  return bufferHandOffSourceInput(input);
}
