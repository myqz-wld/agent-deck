import { useEffect, useState } from 'react';
import type { SessionCommandDescriptor } from '@shared/types';

export function useAdapterSessionCommands(
  agentId: string,
  sessionId: string,
  enabled: boolean,
): SessionCommandDescriptor[] {
  const [commands, setCommands] = useState<SessionCommandDescriptor[]>([]);

  useEffect(() => {
    let cancelled = false;
    setCommands([]);
    if (!enabled) return () => { cancelled = true; };
    void window.api.listAdapterSessionCommands(agentId, sessionId)
      .then((next) => {
        if (!cancelled) setCommands(next);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => { cancelled = true; };
  }, [agentId, enabled, sessionId]);

  return commands;
}
