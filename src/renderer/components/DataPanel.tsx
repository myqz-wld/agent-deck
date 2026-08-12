import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react';
import { PROVIDER_USAGE_RENDERER_STALE_MS } from '../hooks/use-startup-data-preload';
import { useTokenRatesPoll } from '../hooks/use-token-rates-poll';
import {
  requestTokenDailyRefresh,
  retainStrongTokenDailyRefresh,
} from '../lib/token-daily-refresh';
import type { RemoteUsageSourceView } from '../remote-host/use-remote-usage-source';
import { useTokenUsageStore } from '../stores/token-usage-store';
import { DataPanelView } from './data-panel/DataPanelView';

/** Selects exactly one authority adapter; the Remote branch never subscribes to Local stores. */
export function DataPanel({
  remoteUsage = null,
}: {
  remoteUsage?: RemoteUsageSourceView | null;
}): JSX.Element {
  return remoteUsage ? <RemoteDataPanel remoteUsage={remoteUsage} /> : <LocalDataPanel />;
}

function LocalDataPanel(): JSX.Element {
  const rates = useTokenUsageStore((state) => state.rates);
  const liveBySession = useTokenUsageStore((state) => state.liveBySession);
  const daily = useTokenUsageStore((state) => state.daily);
  const usageSnapshots = useTokenUsageStore((state) => state.providerUsageSnapshots);
  const usageFetchedAt = useTokenUsageStore((state) => state.providerUsageFetchedAt);
  const usageLoading = useTokenUsageStore((state) => state.providerUsageLoading);
  const usageError = useTokenUsageStore((state) => state.providerUsageError);
  const mountedRef = useRef(true);
  useTokenRatesPoll(true, 2_500, true);

  useEffect(() => {
    mountedRef.current = true;
    const releaseStrongRefresh = retainStrongTokenDailyRefresh();
    requestTokenDailyRefresh(true);
    return () => {
      mountedRef.current = false;
      releaseStrongRefresh();
    };
  }, []);

  const runProviderRequest = useCallback(async (
    force: boolean,
    showLoading: boolean,
  ): Promise<void> => {
    const store = useTokenUsageStore.getState();
    const requestId = store.beginProviderUsageRequest(showLoading);
    try {
      const result = force
        ? await window.api.providerUsageSnapshot({ force: true })
        : await window.api.providerUsageSnapshot();
      if (mountedRef.current) {
        useTokenUsageStore.getState().setProviderUsageSuccess(requestId, result.snapshots);
      }
    } catch {
      if (mountedRef.current) {
        useTokenUsageStore.getState().setProviderUsageError(
          requestId,
          '额度信息读取失败，请稍后重试',
        );
      }
    }
  }, []);

  useEffect(() => {
    const cacheFresh = usageFetchedAt !== null &&
      Date.now() - usageFetchedAt < PROVIDER_USAGE_RENDERER_STALE_MS;
    if (!cacheFresh) void runProviderRequest(false, usageSnapshots.length === 0);
  }, [runProviderRequest, usageFetchedAt, usageSnapshots.length]);

  const refreshProviders = useCallback(
    (force: boolean) => runProviderRequest(force, true),
    [runProviderRequest],
  );

  const today = useMemo(() => {
    const date = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
  }, []);

  return <DataPanelView
    rates={rates}
    ratesLoading={false}
    ratesError={null}
    liveBySession={liveBySession}
    rateDescription="生成中实时估算 / 最近 60 秒"
    daily={daily}
    today={today}
    dailyLoading={false}
    dailyError={null}
    dailyTruncated={false}
    usageSnapshots={usageSnapshots}
    usageFetchedAt={usageFetchedAt}
    usageLoading={usageLoading}
    usageError={usageError}
    onRefreshProviders={refreshProviders}
  />;
}

function RemoteDataPanel({ remoteUsage }: { remoteUsage: RemoteUsageSourceView }): JSX.Element {
  useEffect(() => {
    if (!remoteUsage.enabled) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        void remoteUsage.loadDaily();
        void remoteUsage.loadProviders(false);
      }
    });
    return () => { cancelled = true; };
  }, [remoteUsage.enabled, remoteUsage.identity]);

  const refreshProviders = useCallback(
    (force: boolean) => remoteUsage.loadProviders(force),
    [remoteUsage],
  );

  return <DataPanelView
    rates={remoteUsage.rates}
    ratesLoading={remoteUsage.ratesLoading}
    ratesError={remoteUsage.ratesError}
    liveBySession={{}}
    rateDescription="最近 60 秒账本（每 2.5 秒刷新）"
    daily={remoteUsage.daily}
    today={remoteUsage.today}
    dailyLoading={remoteUsage.dailyLoading}
    dailyError={remoteUsage.dailyError}
    dailyTruncated={remoteUsage.dailyTruncated}
    usageSnapshots={remoteUsage.providerSnapshots}
    usageFetchedAt={remoteUsage.providerFetchedAt}
    usageLoading={remoteUsage.providerLoading}
    usageError={remoteUsage.providerError}
    onRefreshProviders={refreshProviders}
  />;
}
