import type { InternalSession } from './types';
import { claudeContextWindowFailureReason } from './result-outcome';

type ClaudeSdkFrame = { type: string; [key: string]: unknown };

const MODEL_STREAM_EVENTS = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
]);

/** Lifecycle/configuration/user-echo frames deliberately do not cross this boundary. */
export function observeClaudeTrustedContinuationFrame(
  internal: InternalSession,
  frame: ClaudeSdkFrame,
): void {
  const acceptance = internal.trustedContinuationAcceptance;
  if (!acceptance) return;
  if (frame.type === 'assistant' && typeof frame.error !== 'string') {
    delete internal.trustedContinuationAcceptance;
    acceptance.acceptModelActivity();
    return;
  }
  if (frame.type === 'stream_event') {
    const event = record(frame.event);
    if (typeof event?.type === 'string' && MODEL_STREAM_EVENTS.has(event.type)) {
      delete internal.trustedContinuationAcceptance;
      acceptance.acceptModelActivity();
    }
    return;
  }
  if (frame.type !== 'result') return;
  delete internal.trustedContinuationAcceptance;
  if (frame.subtype === 'success' && frame.is_error !== true) {
    acceptance.acceptModelActivity();
    return;
  }
  acceptance.reject(
    claudeContextWindowFailureReason({ terminal_reason: frame.terminal_reason })
      ?? 'provider-error',
  );
}

export function rejectUnsettledClaudeTrustedContinuation(internal: InternalSession): void {
  const acceptance = internal.trustedContinuationAcceptance;
  if (!acceptance) return;
  delete internal.trustedContinuationAcceptance;
  acceptance.reject('provider-error');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
