import { methods } from '@agentclientprotocol/sdk';
import type { PendingAgentMessage } from '@main/adapters/types';
import type { GrokRuntime, GrokSubmittingMessage } from './runtime-types';
import { requireNativeSession, toPendingAgentMessage } from './turn-queue-helpers';

export async function removePendingGrokOutgoingMessage(
  runtime: GrokRuntime,
  messageId: string,
  drain: () => void,
): Promise<PendingAgentMessage | null> {
  const index = runtime.queue.findIndex((message) => toPendingAgentMessage(message)?.id === messageId);
  if (index >= 0) {
    const [removed] = runtime.queue.splice(index, 1);
    return toPendingAgentMessage(removed);
  }
  const submitting = runtime.submittingMessage;
  const pending = toPendingAgentMessage(submitting?.message);
  if (!submitting || pending?.id !== messageId || submitting.status !== 'submitting') return null;
  if (submitting.kind === 'interject') {
    submitting.status = 'cancelled';
    submitting.requestController?.abort();
    if (runtime.submittingMessage === submitting) runtime.submittingMessage = null;
    drain();
    return pending;
  }
  submitting.status = 'cancelling';
  if (!submitting.promptRequestIssued) {
    submitting.status = 'cancelled';
    return pending;
  }
  try {
    await runtime.process?.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: requireNativeSession(runtime),
    });
  } catch (error) {
    if (runtime.submittingMessage === submitting) submitting.status = 'submitting';
    throw error;
  }
  // Provider echo can win while the cancel notification is being written.
  if (runtime.submittingMessage !== submitting || submitting.status !== 'cancelling') return null;
  submitting.status = 'cancelled';
  // No terminal response is guaranteed. Fence events/dequeue until drain retires this transport.
  runtime.ready = false;
  runtime.suppressUpdates = true;
  submitting.requestController?.abort();
  submitting.cancelPromptRequest?.();
  return pending;
}

/** ACP 1.4 abort sends $/cancel_request but keeps the response pending until the peer settles it. */
export async function runGrokPendingPromptRequest<T>(
  submitting: GrokSubmittingMessage | null,
  request: () => Promise<T>,
): Promise<T> {
  if (!submitting) return request();
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  // Separate from the RPC signal: an earlier ordinary interrupt may have already aborted it.
  const cancel = () => rejectCancellation(new Error('Grok pending prompt cancelled'));
  submitting.cancelPromptRequest = cancel;
  try {
    return await Promise.race([request(), cancellation]);
  } finally {
    if (submitting.cancelPromptRequest === cancel) delete submitting.cancelPromptRequest;
  }
}
