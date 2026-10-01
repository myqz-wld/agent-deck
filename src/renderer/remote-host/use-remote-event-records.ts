import { useEffect, useRef, useState } from 'react';
import { RemoteReadCache } from '@shared/remote-read-cache';

import { SESSION_EVENT_MAX_ITEMS } from '@contracts/index';
import type { RemoteHostEventListDto } from '@shared/remote-host';

const recordsCache = new RemoteReadCache<RemoteHostEventListDto>(24);

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
  const key = JSON.stringify([input.identity, input.activeProfileId, input.selectedSessionId]);
  const enabled = input.usable && Boolean(input.activeProfileId && input.selectedSessionId) && input.capabilities.has('events.replay');
  const [state, setState] = useState<RemoteEventRecordsState & { key: string }>(() => ({ key, error: null, value: enabled ? recordsCache.get(key) : null }));
  const sequence = useRef(0);
  const targetKey = useRef('');

  useEffect(() => {
    const current = ++sequence.current;
    const {
      activeProfileId, capabilities, identity, selectedSessionId, usable,
    } = input;
    const nextKey = JSON.stringify([identity, activeProfileId, selectedSessionId]);
    const changedTarget = targetKey.current !== nextKey;
    targetKey.current = nextKey;
    if (
      !usable || !activeProfileId || !selectedSessionId ||
      !capabilities.has('events.replay')
    ) {
      if (!usable || !capabilities.has('events.replay')) recordsCache.clear();
      setState({ key: nextKey, error: null, value: null });
      return;
    }
    setState((previous) => ({
      key: nextKey, error: null,
      value: changedTarget ? recordsCache.get(nextKey) : previous.value,
    }));
    void window.api.listRemoteHostEvents({
      profileId: activeProfileId,
      sessionId: selectedSessionId,
      limit: SESSION_EVENT_MAX_ITEMS,
    }).then((value) => {
      if (sequence.current !== current || targetKey.current !== nextKey) return;
      recordsCache.set(nextKey, value);
      setState({ key: nextKey, error: null, value });
    }).catch((reason: unknown) => {
      if (sequence.current !== current || targetKey.current !== nextKey) return;
      setState((previous) => ({
        key: nextKey, error: reason instanceof Error ? reason.message : String(reason),
        value: previous.key === nextKey ? previous.value : recordsCache.get(nextKey),
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

  return !enabled ? { error: null, value: null } : state.key === key ? { error: state.error, value: state.value } : { error: null, value: recordsCache.get(key) };
}
