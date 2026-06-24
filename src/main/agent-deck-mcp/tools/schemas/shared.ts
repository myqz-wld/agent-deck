/** Shared descriptions for Agent Deck MCP tool schemas. */

export const SDK_CALLER_SESSION_ID_DESCRIPTION =
  'Leave unset in SDK sessions; Agent Deck injects the real caller session id and ignores forged in-prompt values. Direct HTTP/stdio callers without a real Agent Deck session are treated as external.';
export const SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION =
  `${SDK_CALLER_SESSION_ID_DESCRIPTION} This tool rejects external callers.`;
export const SDK_READ_CALLER_SESSION_ID_DESCRIPTION =
  `${SDK_CALLER_SESSION_ID_DESCRIPTION} Read-only external callers may call read tools; each tool defines its own visibility and authorization semantics.`;
