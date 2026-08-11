import type { AgentAdapter } from '@main/adapters/types';

/** Prefer a live provider runtime's negotiation; fall back only when no runtime is addressable. */
export function canAcceptServerCoreSessionAttachments(
  adapter: AgentAdapter,
  sessionId: string,
): boolean {
  return adapter.canAcceptSessionAttachments?.(sessionId) ??
    adapter.capabilities.canAcceptAttachments;
}
