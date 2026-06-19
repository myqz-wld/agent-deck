import { useEffect } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';

export const PROVIDER_USAGE_REFETCH_MS = 5 * 60_000;
export const PROVIDER_USAGE_RENDERER_STALE_MS = PROVIDER_USAGE_REFETCH_MS - 5_000;

/**
 * App-level cold data preload and background quota refresh for the Data tab.
 *
 * The main process also warms the provider-usage TTL cache on startup, but the
 * renderer store still needs a snapshot before DataPanel mounts; otherwise the
 * first Data tab visit has to populate UI state and visibly looks lazy-loaded.
 * Keep provider usage refreshed here, not in DataPanel, so quota data stays
 * current even while the user is on other tabs.
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

    const refreshProviderUsage = (): void => {
      void window.api
        .providerUsageSnapshot()
        .then((result) => {
          if (!cancelled) setProviderUsageSuccess(result.snapshots);
        })
        .catch((err) => {
          console.warn('[app] providerUsageSnapshot background refresh failed', err);
        });
    };

    refreshProviderUsage();
    const providerUsageTimer = setInterval(refreshProviderUsage, PROVIDER_USAGE_REFETCH_MS);

    return () => {
      cancelled = true;
      clearInterval(providerUsageTimer);
    };
  }, [setDaily, setProviderUsageSuccess]);
}
