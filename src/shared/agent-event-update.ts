import type { AgentEvent } from './types';

/** Stable provider plan identity; ordinary thought messages remain independent. */
export function planEventId(event: AgentEvent): string | null {
  if (event.kind !== 'thinking') return null;
  const payload = event.payload as { plan?: unknown; planId?: unknown } | null;
  return payload?.plan === true && typeof payload.planId === 'string' && payload.planId.length > 0
    ? payload.planId : null;
}
