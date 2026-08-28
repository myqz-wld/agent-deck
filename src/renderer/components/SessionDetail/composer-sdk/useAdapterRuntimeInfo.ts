import { useEffect, useState } from 'react';
import type { AdapterSessionMode } from '@shared/types';

interface AdapterRuntimeInfo {
  adapterId: string;
  canAcceptAttachments: boolean;
  canSetPermissionMode: boolean;
  canSetSessionMode: boolean;
  sessionModes: AdapterSessionMode[];
  loading: boolean;
}

function unavailable(agentId: string, loading: boolean): AdapterRuntimeInfo {
  return {
    adapterId: agentId,
    canAcceptAttachments: false,
    canSetPermissionMode: false,
    canSetSessionMode: false,
    sessionModes: [],
    loading,
  };
}

export function useAdapterRuntimeInfo(agentId: string): AdapterRuntimeInfo {
  const [info, setInfo] = useState<AdapterRuntimeInfo>(() => unavailable(agentId, true));
  const current = info.adapterId === agentId ? info : unavailable(agentId, true);

  useEffect(() => {
    let cancelled = false;
    setInfo(unavailable(agentId, true));
    void window.api
      .listAdapters()
      .then((adapters) => {
        if (cancelled) return;
        const adapter = adapters.find((candidate) => candidate.id === agentId);
        setInfo(
          adapter
            ? {
                adapterId: agentId,
                canAcceptAttachments:
                  adapter.capabilities.canAcceptAttachments === true,
                canSetPermissionMode:
                  adapter.capabilities.canSetPermissionMode === true,
                canSetSessionMode:
                  adapter.capabilities.canSetSessionMode === true,
                sessionModes: adapter.sessionModes ?? [],
                loading: false,
              }
            : unavailable(agentId, false),
        );
      })
      .catch(() => {
        if (!cancelled) setInfo(unavailable(agentId, false));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return current;
}
