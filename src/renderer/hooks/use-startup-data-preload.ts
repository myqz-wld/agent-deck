import { useEffect } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';

/**
 * App-level cold data preload for the Data tab.
 *
 * The main process also warms the provider-usage TTL cache on startup, but the
 * renderer store still needs a snapshot before DataPanel mounts; otherwise the
 * first Data tab visit has to populate UI state and visibly looks lazy-loaded.
 */
export function useStartupDataPreload(): void {
  const setDaily = useTokenUsageStore((s) => s.setDaily);
  const setProviderUsageSuccess = useTokenUsageStore((s) => s.setProviderUsageSuccess);

  useEffect(() => {
    let cancelled = false;

    void window.api
      .tokenUsageDaily()
      .then((rows) => {
        if (!cancelled) setDaily(rows);
      })
      .catch((err) => {
        console.warn('[app] tokenUsageDaily preload failed', err);
      });

    void window.api
      .providerUsageSnapshot()
      .then((result) => {
        if (!cancelled) setProviderUsageSuccess(result.snapshots);
      })
      .catch((err) => {
        console.warn('[app] providerUsageSnapshot preload failed', err);
      });

    return () => {
      cancelled = true;
    };
  }, [setDaily, setProviderUsageSuccess]);
}
