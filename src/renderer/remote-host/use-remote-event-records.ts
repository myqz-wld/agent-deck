import { useEffect, useRef, useState } from 'react';

import { SESSION_EVENT_MAX_ITEMS } from '@contracts/index';
import type { RemoteHostEventListDto } from '@shared/remote-host';

export interface RemoteEventRecordsState {
  error: string | null;
  value: RemoteHostEventListDto | null;
}

/** Reads one source-qualified event page without ever consulting Local event IPC. */
export function useRemoteEventRecords(input: {
  activeProfileId: string | null;
  capabilities: ReadonlySet<string>;
  dataRevision: number;
  identity: string;
  selectedSessionId: string | null;
  usable: boolean;
}): RemoteEventRecordsState {
  const [state, setState] = useState<RemoteEventRecordsState>({ error: null, value: null });
  const sequence = useRef(0);
  const targetKey = useRef('');

  useEffect(() => {
    const current = ++sequence.current;
    const {
      activeProfileId, capabilities, identity, selectedSessionId, usable,
    } = input;
    const nextKey = activeProfileId && selectedSessionId
      ? `${identity}\u0000${selectedSessionId}`
      : '';
    const changedTarget = targetKey.current !== nextKey;
    targetKey.current = nextKey;
    if (
      !usable || !activeProfileId || !selectedSessionId ||
      !capabilities.has('events.replay')
    ) {
      setState({ error: null, value: null });
      return;
    }
    setState((previous) => ({
      error: null,
      value: changedTarget ? null : previous.value,
    }));
    void window.api.listRemoteHostEvents({
      profileId: activeProfileId,
      sessionId: selectedSessionId,
      limit: SESSION_EVENT_MAX_ITEMS,
    }).then((value) => {
      if (sequence.current !== current || targetKey.current !== nextKey) return;
      setState({ error: null, value });
    }).catch((reason: unknown) => {
      if (sequence.current !== current || targetKey.current !== nextKey) return;
      setState((previous) => ({
        error: reason instanceof Error ? reason.message : String(reason),
        value: changedTarget ? null : previous.value,
      }));
    });
    return () => {
      if (sequence.current === current) sequence.current += 1;
    };
  }, [
    input.activeProfileId,
    input.capabilities,
    input.dataRevision,
    input.identity,
    input.selectedSessionId,
    input.usable,
  ]);

  return state;
}
