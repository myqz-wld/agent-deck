import type { UploadedAttachmentRef } from '@shared/types';
import type { AgentEnqueueOptions } from './types/agent-adapter';

const MAX_ACCEPTED_ENQUEUE_KEYS = 1_024;

export interface AdapterRecoveryDeliveryOptions {
  userEventAlreadyPersisted?: boolean;
  initialEnqueueOptions?: AgentEnqueueOptions;
  sendAfterRecovery?: (sessionId: string) => Promise<void>;
}

export interface InitialEnqueueState {
  deferredUserEvent: {
    text: string;
    attachments?: UploadedAttachmentRef[];
    turnCorrelationId?: string;
  } | null;
  acceptedEnqueueFingerprints?: Map<string, string>;
}

export function enqueuePayloadFingerprint(
  text: string,
  attachments?: UploadedAttachmentRef[],
): string {
  return JSON.stringify({ text, attachments: attachments ?? [] });
}

/** Return true for an already accepted identical payload; reject key reuse for another payload. */
export function isAcceptedEnqueueRetry(
  accepted: ReadonlyMap<string, string>,
  key: string,
  fingerprint: string,
): boolean {
  const previous = accepted.get(key);
  if (previous === undefined) return false;
  if (previous !== fingerprint) {
    throw new Error('enqueue idempotency key was already accepted for a different payload');
  }
  return true;
}

export function rememberAcceptedEnqueue(
  accepted: Map<string, string>,
  key: string,
  fingerprint: string,
): void {
  accepted.set(key, fingerprint);
  while (accepted.size > MAX_ACCEPTED_ENQUEUE_KEYS) {
    const oldest = accepted.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    accepted.delete(oldest);
  }
}

/** Bind recovery's first provider input to the same queue metadata as an already-live enqueue. */
export function buildInitialEnqueueState(
  text: string,
  attachments: UploadedAttachmentRef[] | undefined,
  options: AgentEnqueueOptions | undefined,
): InitialEnqueueState {
  let acceptedEnqueueFingerprints: Map<string, string> | undefined;
  if (options?.idempotencyKey) {
    acceptedEnqueueFingerprints = new Map();
    rememberAcceptedEnqueue(
      acceptedEnqueueFingerprints,
      options.idempotencyKey,
      enqueuePayloadFingerprint(text, attachments),
    );
  }
  return {
    deferredUserEvent: options?.deferUserEventUntilTurnStart
      ? {
          text,
          ...(attachments?.length
            ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
            : {}),
          ...(options.turnCorrelationId
            ? { turnCorrelationId: options.turnCorrelationId }
            : {}),
        }
      : null,
    ...(acceptedEnqueueFingerprints ? { acceptedEnqueueFingerprints } : {}),
  };
}
