import { useEffect } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';
import {
  PROVIDER_USAGE_CACHE_TTL_MS,
  PROVIDER_USAGE_REFETCH_MS,
} from '@shared/constants/provider-usage';
import log from '@renderer/utils/logger';
import { startTokenDailyRefresh } from '../lib/token-daily-refresh';

const logger = log.scope('renderer-startup-data-preload');

export { PROVIDER_USAGE_REFETCH_MS };
export const PROVIDER_USAGE_RENDERER_STALE_MS = PROVIDER_USAGE_CACHE_TTL_MS;

/**
 * App-level cold data preload and background quota refresh for the Data tab.
 *
 * The main process also warms the provider-usage TTL cache on startup, but the
 * renderer store still needs a snapshot before DataPanel mounts; otherwise the
 * first Data tab visit has to populate UI state and visibly looks lazy-loaded.
 * Keep provider usage refreshed here, not in DataPanel, so quota data stays
 * current even while the user is on other tabs.
 */
export function useStartupDataPreload(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const stopTokenDailyRefresh = startTokenDailyRefresh();

    const refreshProviderUsage = (): void => {
      const requestId = useTokenUsageStore.getState().beginProviderUsageRequest(false);
      void window.api
        .providerUsageSnapshot()
        .then((result) => {
          if (!cancelled) {
            useTokenUsageStore.getState().setProviderUsageSuccess(requestId, result.snapshots);
          }
        })
        .catch((err) => {
          if (!cancelled) useTokenUsageStore.getState().finishProviderUsageRequest(requestId);
          logger.warn('[app] providerUsageSnapshot background refresh failed', err);
        });
    };

    refreshProviderUsage();
    const providerUsageTimer = setInterval(refreshProviderUsage, PROVIDER_USAGE_REFETCH_MS);

    return () => {
      cancelled = true;
      stopTokenDailyRefresh();
      clearInterval(providerUsageTimer);
    };
  }, [enabled]);
}
