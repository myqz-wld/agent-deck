import { useEffect } from 'react';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import { useSessionStore } from '@renderer/stores/session-store';
import log from '@renderer/utils/logger';
import { useEventBridge } from './use-event-bridge';
import { useIssuesBridge } from './use-issues-bridge';
import { useStartupDataPreload } from './use-startup-data-preload';

const logger = log.scope('renderer-local-app-bridges');

/** Mount every Local business bridge only while Local is the authoritative source. */
export function useLocalAppBridges(enabled: boolean): void {
  useEventBridge(enabled);
  useIssuesBridge(enabled);
  useStartupDataPreload(enabled);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadStableSnapshot({
      readVersion: () => useSessionStore.getState().pendingRevisionsBySession,
      load: async () => {
        const adapters = await window.api.listAdapters();
        const snapshots = await Promise.all(adapters.map(async (adapter) => {
          try {
            return await window.api.listAdapterPendingAll(adapter.id);
          } catch (err) {
            throw new Error(`listAdapterPendingAll(${adapter.id}) failed`, { cause: err });
          }
        }));
        const combined: Parameters<ReturnType<typeof useSessionStore.getState>['setPendingRequestsAll']>[0] = {};
        for (const snapshot of snapshots) Object.assign(combined, snapshot);
        return combined;
      },
      apply: (snapshot) => useSessionStore.getState().setPendingRequestsAll(snapshot),
      isCancelled: () => cancelled,
    }).then((result) => {
      if (result === 'unstable') logger.warn('[app] pending snapshot stayed unstable; kept live state');
    }).catch((err: unknown) => {
      if (!cancelled) logger.warn('[app] initial pending snapshot failed', err);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
