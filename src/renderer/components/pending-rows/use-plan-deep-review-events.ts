import { useCallback, useEffect, useState } from 'react';

import type { AgentEvent, PlanDeepReviewSession } from '@shared/types';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import { RECENT_LIMIT, useSessionStore } from '@renderer/stores/session-store';
import type { PlanDeepReviewTransport } from '@renderer/plan-review/transport';

const EMPTY_EVENTS: AgentEvent[] = [];

export function usePlanDeepReviewEvents(
  open: boolean,
  child: PlanDeepReviewSession | null,
  transport: PlanDeepReviewTransport | undefined,
): { childEvents: AgentEvent[]; loadEvents(child: PlanDeepReviewSession): Promise<void> } {
  const setRecentEvents = useSessionStore((state) => state.setRecentEvents);
  const localEvents = useSessionStore((state) =>
    child ? state.recentEventsBySession.get(child.sessionId) ?? EMPTY_EVENTS : EMPTY_EVENTS);
  const [remoteEvents, setRemoteEvents] = useState<AgentEvent[]>(EMPTY_EVENTS);

  const loadEvents = useCallback(async (activeChild: PlanDeepReviewSession): Promise<void> => {
    if (transport) {
      const events = await transport.listEvents(activeChild.sessionId);
      setRemoteEvents(events);
      return;
    }
    await loadStableSnapshot({
      readVersion: () =>
        useSessionStore.getState().eventRevisionsBySession.get(activeChild.sessionId) ?? 0,
      load: () => window.api.listEvents(activeChild.sessionId, RECENT_LIMIT),
      apply: (events) => setRecentEvents(activeChild.sessionId, events),
    });
  }, [setRecentEvents, transport]);

  useEffect(() => {
    if (!open || !child || !transport) return;
    let current = true;
    void transport.listEvents(child.sessionId).then((events) => {
      if (current) setRemoteEvents(events);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [child, open, transport, transport?.identity, transport?.revision]);

  useEffect(() => {
    if (!child) setRemoteEvents(EMPTY_EVENTS);
  }, [child]);

  return { childEvents: transport ? remoteEvents : localEvents, loadEvents };
}
