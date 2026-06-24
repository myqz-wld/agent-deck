import type { AgentEvent } from '@shared/types';

export function isExplicitSdkUserMessage(event: AgentEvent): boolean {
  if (event.source !== 'sdk' || event.kind !== 'message') return false;
  const payload = event.payload as { role?: unknown } | null | undefined;
  return payload?.role === 'user';
}
