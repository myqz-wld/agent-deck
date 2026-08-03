import type {
  HandOffSourceCutoverCheck,
  HandOffSourceCutoverRejectionReason,
  HandOffSourceCutoverResult,
} from '@main/session/hand-off/source-precondition';
import type { HandOffTrustedContinuationFailureReason } from '@main/session/hand-off/trusted-continuation-gate';
import type { HandOffSuccessorCleanup } from '@main/session/hand-off/trusted-continuation-gate';

export function safelyCheckSourcePrecondition(
  check: (input: HandOffSourceCutoverCheck) => HandOffSourceCutoverResult,
  input: HandOffSourceCutoverCheck,
): HandOffSourceCutoverResult {
  try {
    return check(input);
  } catch {
    return { ok: false, reason: 'check-failed', currentEventRevision: null };
  }
}

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
  reason:
    | HandOffSourceCutoverRejectionReason
    | HandOffTrustedContinuationFailureReason
    | null,
  successorSessionId: string | null,
  successorCleanup: HandOffSuccessorCleanup,
): { error: string; hint: string } {
  if (reason === 'target-startup-timeout') {
    if (successorCleanup === 'ok') {
      return {
        error: 'handoff readiness expired before successor startup began',
        hint:
          'No successor was created and no resources moved. Prepare a fresh continuation context before retrying.',
      };
    }
    return {
      error: 'handoff successor startup exceeded the trusted continuation readiness deadline',
      hint:
        'No resources moved and no stable successor id was available. A late candidate will be closed automatically; inspect the session list and application logs before retrying.',
    };
  }
  if (reason === 'target-retry-startup-failed') {
    return {
      error: 'handoff lower-budget successor failed to start',
      hint:
        'The lower-budget attempt produced no stable successor id, no cleanup is required, and the source remains active. Inspect the target provider logs, then prepare a fresh handoff before retrying.',
    };
  }
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
  if (reason?.startsWith('target-')) {
    return {
      error: 'handoff successor did not cross the trusted continuation readiness boundary',
      hint: `${prefix} The source remains active; inspect the target provider and retry when appropriate.`,
    };
  }
  return {
    error: 'source session changed while creating the handoff successor',
    hint: `${prefix} Prepare a fresh continuation context and retry.`,
  };
}
