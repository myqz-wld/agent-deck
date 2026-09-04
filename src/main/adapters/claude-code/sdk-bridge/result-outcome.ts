export function claudeContextWindowFailureReason(
  result: { terminal_reason?: unknown },
): 'context-window-exceeded' | null {
  return result.terminal_reason === 'prompt_too_long'
    ? 'context-window-exceeded'
    : null;
}

export function claudeFinishedPayload(result: {
  subtype?: string;
  is_error?: boolean;
  terminal_reason?: unknown;
}): {
  ok: boolean;
  subtype: string | undefined;
  failureReason?: 'context-window-exceeded';
} {
  const failureReason = claudeContextWindowFailureReason(result);
  return {
    ok: result.subtype === 'success' && !result.is_error,
    subtype: result.subtype,
    ...(failureReason ? { failureReason } : {}),
  };
}
