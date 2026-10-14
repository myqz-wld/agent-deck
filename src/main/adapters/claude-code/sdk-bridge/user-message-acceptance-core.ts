import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';
import { preserveClaudeUserMessageCore } from './user-message-recovery-core';

const MAX_IGNORED_USER_MESSAGE_IDS = 32;
const SLOW_INPUT_ACCEPTANCE_MS = 2_000;

export interface ClaudeInputAcceptanceTiming {
  sessionId: string;
  messageId: string;
  appQueueMs: number;
  sdkAcceptanceMs: number;
  acceptanceFrame: string;
  midTurn: boolean;
}

export interface ClaudeUserMessageAcceptanceHost {
  readonly agentId: string;
  now(): number;
  observeSlowAcceptance?(timing: ClaudeInputAcceptanceTiming): void;
}

interface ClaudeAcceptanceFrame {
  type: string;
  uuid?: unknown;
  parent_tool_use_id?: unknown;
  user_message_uuid?: unknown;
  user_message_uuids?: unknown;
  event?: unknown;
}

function isAssistantResponseStart(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || !('type' in event)) return false;
  if (event.type !== 'message_start' || !('message' in event)) return false;
  const message = event.message;
  return typeof message === 'object' && message !== null
    && 'role' in message && message.role === 'assistant';
}

/** Task notifications and scheduled prompts can start a main turn without an application send. */
export function isClaudeMainResponseFrame(msg: ClaudeAcceptanceFrame): boolean {
  return msg.parent_tool_use_id == null && (msg.type === 'assistant' ||
    (msg.type === 'stream_event' && isAssistantResponseStart(msg.event)));
}

export function confirmClaudeUserMessageAcceptanceCore(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  msg: ClaudeAcceptanceFrame,
  internal: InternalSession,
  host: ClaudeUserMessageAcceptanceHost,
): void {
  if (
    msg.type === 'user' &&
    typeof msg.uuid === 'string' &&
    internal.ignoredUserMessageIds?.delete(msg.uuid)
  ) return;
  const submitting = internal.submittingUserMessage;
  if (!submitting || msg.parent_tool_use_id != null) return;
  if (msg.type === 'user') {
    if (typeof msg.uuid !== 'string') return;
    if (submitting.providerMessageId !== msg.uuid) return;
  } else {
    if (!['assistant', 'stream_event', 'result'].includes(msg.type)) return;
    const ids = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : [];
    const correlated = msg.user_message_uuid === submitting.providerMessageId
      || ids.includes(submitting.providerMessageId);
    const startsResponse = isClaudeMainResponseFrame(msg);
    if (!correlated && (
      !startsResponse
      || submitting.precedingTurn != null
      || typeof msg.user_message_uuid === 'string'
      || ids.length > 0
    )) return;
  }
  // Replay acknowledgements retain the input UUID even when persisted user frames replace it.
  // For idle input, message_start is sufficient: waiting for a completed assistant block also
  // waits for extended thinking. Mid-turn input still requires explicit UUID correlation.
  const deferred = submitting.pending.deferredUserEvent;
  if (!deferred) {
    internal.submittingUserMessage = null;
    return;
  }
  const acceptedAt = host.now();
  if (submitting.pending.enqueuedAt != null && submitting.submittedAt != null) {
    const appQueueMs = Math.max(0, submitting.submittedAt - submitting.pending.enqueuedAt);
    const sdkAcceptanceMs = Math.max(0, acceptedAt - submitting.submittedAt);
    if (appQueueMs + sdkAcceptanceMs >= SLOW_INPUT_ACCEPTANCE_MS) {
      try {
        host.observeSlowAcceptance?.({
          sessionId,
          messageId: submitting.providerMessageId,
          appQueueMs,
          sdkAcceptanceMs,
          acceptanceFrame: msg.type,
          midTurn: submitting.precedingTurn != null,
        });
      } catch {
        // Diagnostics cannot reject acceptance or prevent the next queued input from waking.
      }
    }
  }
  emit({
    sessionId,
    agentId: host.agentId,
    kind: 'message',
    payload: {
      text: deferred.text,
      role: 'user',
      ...(deferred.attachments?.length ? { attachments: deferred.attachments } : {}),
      ...(deferred.turnCorrelationId
        ? { turnCorrelationId: deferred.turnCorrelationId }
        : {}),
    },
    ts: acceptedAt,
    source: 'sdk',
  });
  internal.submittingUserMessage = null;
  const notify = internal.notify;
  internal.notify = null;
  notify?.();
}

/** An older turn's result must not drop a correction already handed to the SDK. */
export function finishClaudeUserMessageTurnCore(
  internal: InternalSession,
  emit: (event: AgentEvent) => void,
  sessionId: string,
  host: ClaudeUserMessageAcceptanceHost,
): void {
  const submitting = internal.submittingUserMessage;
  if (submitting?.precedingTurn) {
    submitting.precedingTurn = 'finished';
    return;
  }
  if (submitting && !internal.expectedClose && !internal.retireRequested) {
    preserveClaudeUserMessageCore(emit, sessionId, submitting.pending, 'unknown', host);
  }
  discardClaudeSubmittingUserMessageCore(internal);
}

export function discardClaudeSubmittingUserMessageCore(
  internal: InternalSession,
): void {
  const submitting = internal.submittingUserMessage;
  if (!submitting) return;
  rememberIgnoredClaudeUserMessageIdCore(internal, submitting.providerMessageId);
  internal.submittingUserMessage = null;
}

export function rememberIgnoredClaudeUserMessageIdCore(
  internal: InternalSession,
  messageId: string,
): void {
  const ignored = (internal.ignoredUserMessageIds ??= new Set());
  ignored.add(messageId);
  while (ignored.size > MAX_IGNORED_USER_MESSAGE_IDS) {
    const oldest = ignored.values().next().value;
    if (!oldest) break;
    ignored.delete(oldest);
  }
}
