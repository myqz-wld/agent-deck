import type { HandOffSourceCutoverRejectionReason } from '@main/session/hand-off/source-precondition';

export function sourceChangeError(reason: HandOffSourceCutoverRejectionReason): {
  error: string;
  hint: string;
} {
  if (reason === 'late-attachment-invalid') {
    return {
      error: 'source session received a late attachment that cannot be replayed safely',
      hint:
        'No successor was created and no resources moved. Prepare a fresh handoff so the attachment is included in the trusted continuation turn.',
    };
  }
  return {
    error: 'source session changed while preparing continuation context',
    hint: 'No successor was created and no resources moved. Prepare a fresh handoff from the current source state.',
  };
}

export function executionCutoverError(
  reason: HandOffSourceCutoverRejectionReason | null,
  successorSessionId: string,
  successorCleanup: 'ok' | 'failed',
): { error: string; hint: string } {
  const prefix =
    `No resources moved. Orphan successor ${successorSessionId} cleanup: ${successorCleanup}.`;
  if (reason === 'late-message-delivery-failed') {
    return {
      error: 'failed to deliver late source messages to the handoff successor',
      hint:
        `${prefix} The source remains active; retry after the target adapter can accept the queued messages.`,
    };
  }
  if (reason === 'message-delivery-drain-timeout') {
    return {
      error: 'source message delivery did not drain before handoff cutover',
      hint:
        `${prefix} The source remains active; retry after its active cross-session delivery reaches a durable terminal or retry state.`,
    };
  }
  return {
    error: 'source session changed while creating the handoff successor',
    hint: `${prefix} Prepare a fresh continuation context and retry.`,
  };
}
