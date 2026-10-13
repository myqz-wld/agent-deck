import type { InternalSession } from './types';

interface ClaudeResultFrame {
  [key: string]: unknown;
  subtype?: unknown;
  is_error?: unknown;
  errors?: unknown;
  terminal_reason?: unknown;
  user_message_uuid?: unknown;
  user_message_uuids?: unknown;
}

// Claude reports an interrupted thinking/tool turn as an execution error on affected CLIs.
// Match only that diagnostic, not other SDK failures or arbitrary errors containing its name.
const USER_INTERRUPTION_DIAGNOSTIC =
  /^\[ede_diagnostic\] result_type=user last_content_type=n\/a stop_reason=(?:null|tool_use)$/;

/** Settle consumed corrections and recognize an older turn preempted by a later user input. */
export function finishClaudeUserMessageInterruptionCore(
  internal: InternalSession,
  result: ClaudeResultFrame,
): boolean {
  const pending = internal.midTurnUserMessageIds;
  if (!pending?.size) return false;
  const consumedIds = new Set([
    result.user_message_uuid,
    ...(Array.isArray(result.user_message_uuids) ? result.user_message_uuids : []),
  ].filter((id): id is string => typeof id === 'string'));
  // Inputs can coalesce into one turn. A result for a newer input also settles earlier ones,
  // including producers that echo only the final UUID instead of the whole consumed UUID list.
  const orderedIds = [...pending];
  let lastConsumed = -1;
  for (let index = 0; index < orderedIds.length; index += 1) {
    if (consumedIds.has(orderedIds[index]!)) lastConsumed = index;
  }
  for (let index = 0; index <= lastConsumed; index += 1) pending.delete(orderedIds[index]!);
  const hasFollowup = pending.size > 0;
  // Legacy uncorrelated results cannot keep an interruption allowance alive for later turns.
  if (consumedIds.size === 0) pending.clear();
  return hasFollowup
    && result.subtype === 'error_during_execution'
    && result.is_error === true
    && (result.terminal_reason == null
      || result.terminal_reason === 'aborted_streaming'
      || result.terminal_reason === 'aborted_tools')
    && Array.isArray(result.errors)
    && result.errors.length > 0
    && result.errors.every((error) => typeof error === 'string'
      && USER_INTERRUPTION_DIAGNOSTIC.test(error.trim()));
}
