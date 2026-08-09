import type { CodexBridgeRuntimeHost } from '../runtime-host-core';

const UNIVERSAL_WIRE_PREFIX = /^\[from [^\n]*\]\[msg [0-9a-f-]+\]\[sid [0-9a-f-]+\]\n/;

/** True when the watcher is retrying provider delivery for an already-persisted wire message. */
export function isRetryingUniversalDelivery(
  sessionId: string,
  text: string,
  runtimeHost: Pick<CodexBridgeRuntimeHost, 'hasExactUserMessage'>,
): boolean {
  return UNIVERSAL_WIRE_PREFIX.test(text) && runtimeHost.hasExactUserMessage(sessionId, text);
}
