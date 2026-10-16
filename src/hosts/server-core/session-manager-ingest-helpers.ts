import type { AgentEvent } from '@shared/types';
import type { UpsertOptions } from '@main/session/manager/_deps';

export function explicitSdkUserMessage(event: AgentEvent): boolean {
  if (event.source !== 'sdk' || event.kind !== 'message') return false;
  return (event.payload as { role?: unknown } | null | undefined)?.role === 'user';
}

export function initialSdkRegistration(event: AgentEvent): Pick<
  UpsertOptions,
  'hiddenFromHistory' | 'spawnDepth' | 'spawnedBy'
> {
  if (event.source !== 'sdk' || event.kind !== 'session-start') return {};
  const payload = event.payload as {
    initialHiddenFromHistory?: unknown;
    initialSpawnLink?: { depth?: unknown; parentSessionId?: unknown };
  } | null | undefined;
  const link = payload?.initialSpawnLink;
  if (
    typeof link?.parentSessionId !== 'string' ||
    link.parentSessionId.length === 0 ||
    !Number.isInteger(link.depth) ||
    Number(link.depth) <= 0
  ) {
    return { hiddenFromHistory: payload?.initialHiddenFromHistory === true };
  }
  return {
    hiddenFromHistory: payload?.initialHiddenFromHistory === true,
    spawnedBy: link.parentSessionId,
    spawnDepth: Number(link.depth),
  };
}

export function isHandOffBuffered(event: AgentEvent): boolean {
  return event.kind === 'message' &&
    event.payload !== null &&
    typeof event.payload === 'object' &&
    (event.payload as { handOffBuffered?: unknown }).handOffBuffered === true;
}
