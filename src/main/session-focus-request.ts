let pendingSessionId: string | null = null;

/** Remember the latest focus target until the renderer explicitly consumes it. */
export function rememberSessionFocusRequest(sessionId: string): void {
  pendingSessionId = sessionId;
}

/** Atomically return and clear the latest focus target. */
export function takePendingSessionFocusRequest(): string | null {
  const sessionId = pendingSessionId;
  pendingSessionId = null;
  return sessionId;
}
