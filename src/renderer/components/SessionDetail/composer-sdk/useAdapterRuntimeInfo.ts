import { useEffect, useState } from 'react';
import type { AdapterSessionMode } from '@shared/types';

interface AdapterRuntimeInfo {
  canAcceptAttachments: boolean;
  canSetPermissionMode: boolean;
  canSetSessionMode: boolean;
  sessionModes: AdapterSessionMode[];
}

const unavailable: AdapterRuntimeInfo = {
  canAcceptAttachments: false,
  canSetPermissionMode: false,
  canSetSessionMode: false,
  sessionModes: [],
};

export function useAdapterRuntimeInfo(agentId: string): AdapterRuntimeInfo {
  const [info, setInfo] = useState<AdapterRuntimeInfo>(unavailable);

  useEffect(() => {
    let cancelled = false;
    setInfo(unavailable);
    void window.api
      .listAdapters()
      .then((adapters) => {
        if (cancelled) return;
        const adapter = adapters.find((candidate) => candidate.id === agentId);
        setInfo(
          adapter
            ? {
                canAcceptAttachments:
                  adapter.capabilities.canAcceptAttachments === true,
                canSetPermissionMode:
                  adapter.capabilities.canSetPermissionMode === true,
                canSetSessionMode:
                  adapter.capabilities.canSetSessionMode === true,
                sessionModes: adapter.sessionModes ?? [],
              }
            : unavailable,
        );
      })
      .catch(() => {
        if (!cancelled) setInfo(unavailable);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return info;
}
