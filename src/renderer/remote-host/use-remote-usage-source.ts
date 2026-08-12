import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { USAGE_DAILY_MAX_ITEMS } from '@contracts/index';
import type {
  ProviderUsageSnapshot,
  TokenDailyRow,
  TokenRateRow,
} from '@shared/types';
import type { RemoteSessionSourceView } from './source-types';

const POLL_MS = 2_500;
const PROVIDER_REFRESH_MS = 10 * 60_000;

export interface RemoteUsageSourceView {
  enabled: boolean;
  identity: string;
  rates: TokenRateRow[];
  topToday: TokenRateRow[];
  ratesLoading: boolean;
  ratesError: string | null;
  today: string | null;
  daily: TokenDailyRow[];
  dailyLoading: boolean;
  dailyError: string | null;
  dailyTruncated: boolean;
  providerSnapshots: ProviderUsageSnapshot[];
  providerFetchedAt: number | null;
  providerLoading: boolean;
  providerError: string | null;
  loadDaily(): Promise<void>;
  loadProviders(force?: boolean): Promise<void>;
}

export function useRemoteUsageSource(
  source: RemoteSessionSourceView,
  remoteMode: boolean,
  dailyActive = false,
): RemoteUsageSourceView {
  // Capabilities describe the last negotiated Core. They intentionally survive transient state
  // changes, so polling must also require a usable binding or a retired connection will be hit
  // every 2.5 seconds forever.
  const enabled = remoteMode && source.usable && source.state?.status === 'connected' &&
    source.capabilities.has('usage');
  const profileId = source.profile?.id ?? null;
  const identityRef = useRef(source.identity);
  identityRef.current = source.identity;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [rates, setRates] = useState<TokenRateRow[]>([]);
  const [topToday, setTopToday] = useState<TokenRateRow[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [daily, setDaily] = useState<TokenDailyRow[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [dailyTruncated, setDailyTruncated] = useState(false);
  const [providerSnapshots, setProviderSnapshots] = useState<ProviderUsageSnapshot[]>([]);
  const [providerFetchedAt, setProviderFetchedAt] = useState<number | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const rateSeq = useRef(0);
  const dailySeq = useRef(0);
  const providerSeq = useRef(0);
  const providerFlight = useRef<{
    identity: string;
    force: boolean;
    promise: Promise<void>;
  } | null>(null);
  const queuedProviderForce = useRef<{ identity: string; promise: Promise<void> } | null>(null);
  const tokenRequestSeq = useRef(0);
  const appliedRateRequestSeq = useRef(0);
  const tokenFlight = useRef<{
    identity: string;
    includeDaily: boolean;
    promise: Promise<void>;
  } | null>(null);
  const queuedTokenRefresh = useRef<{
    identity: string;
    includeDaily: boolean;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    rateSeq.current += 1;
    dailySeq.current += 1;
    providerSeq.current += 1;
    appliedRateRequestSeq.current = tokenRequestSeq.current;
    queuedTokenRefresh.current = null;
    providerFlight.current = null;
    queuedProviderForce.current = null;
    setRates([]);
    setTopToday([]);
    setRatesLoading(false);
    setRatesError(null);
    setToday(null);
    setDaily([]);
    setDailyLoading(false);
    setDailyError(null);
    setDailyTruncated(false);
    setProviderSnapshots([]);
    setProviderFetchedAt(null);
    setProviderLoading(false);
    setProviderError(null);
  }, [enabled, source.identity]);

  const performTokenLoad = useCallback(async (includeDaily: boolean): Promise<void> => {
    if (!enabledRef.current || identityRef.current !== source.identity || !profileId) return;
    const identity = source.identity;
    const sequence = includeDaily ? dailySeq : rateSeq;
    const seq = ++sequence.current;
    const requestSeq = ++tokenRequestSeq.current;
    setRatesLoading(true);
    setRatesError(null);
    if (includeDaily) {
      setDailyLoading(true);
      setDailyError(null);
    }
    try {
      const result = await window.api.getRemoteHostTokenUsage({
        profileId,
        includeDaily,
        dailyLimit: USAGE_DAILY_MAX_ITEMS,
      });
      if (seq !== sequence.current || identityRef.current !== identity) return;
      if (requestSeq >= appliedRateRequestSeq.current) {
        appliedRateRequestSeq.current = requestSeq;
        setRates(result.rates);
        setTopToday(result.topToday);
        setToday(result.today);
        setRatesLoading(false);
      }
      if (includeDaily) {
        setDaily(result.daily);
        setDailyTruncated(result.dailyTruncated);
        setDailyLoading(false);
      }
    } catch {
      if (seq !== sequence.current || identityRef.current !== identity) return;
      setRatesLoading(false);
      setRatesError('实时用量读取失败，请稍后重试');
      if (includeDaily) {
        setDailyLoading(false);
        setDailyError('Token 使用记录读取失败，请稍后重试');
      }
    }
  }, [profileId, source.identity]);

  const startTokenLoad = useCallback((includeDaily: boolean): Promise<void> => {
    const identity = source.identity;
    let flight!: NonNullable<typeof tokenFlight.current>;
    const promise = performTokenLoad(includeDaily).finally(() => {
      if (tokenFlight.current === flight) tokenFlight.current = null;
    });
    flight = { identity, includeDaily, promise };
    tokenFlight.current = flight;
    return promise;
  }, [performTokenLoad, source.identity]);

  const loadTokens = useCallback((includeDaily: boolean): Promise<void> => {
    if (!enabledRef.current || identityRef.current !== source.identity || !profileId) {
      return Promise.resolve();
    }
    const current = tokenFlight.current;
    if (!current || current.identity !== source.identity) return startTokenLoad(includeDaily);
    const queued = queuedTokenRefresh.current;
    if (queued?.identity === source.identity) {
      queued.includeDaily ||= includeDaily;
      return queued.promise;
    }

    let next!: NonNullable<typeof queuedTokenRefresh.current>;
    const promise = current.promise.catch(() => undefined).then(() => {
      if (queuedTokenRefresh.current === next) queuedTokenRefresh.current = null;
      if (!enabledRef.current || identityRef.current !== source.identity || !profileId) return;
      return startTokenLoad(next.includeDaily);
    }).finally(() => {
      if (queuedTokenRefresh.current === next) queuedTokenRefresh.current = null;
    });
    next = { identity: source.identity, includeDaily, promise };
    queuedTokenRefresh.current = next;
    return promise;
  }, [profileId, source.identity, startTokenLoad]);

  const performProviderLoad = useCallback(async (force: boolean): Promise<void> => {
    if (!enabledRef.current || identityRef.current !== source.identity || !profileId) return;
    const identity = source.identity;
    const seq = ++providerSeq.current;
    setProviderLoading(true);
    setProviderError(null);
    try {
      const result = await window.api.getRemoteHostProviderUsage({ profileId, force });
      if (seq !== providerSeq.current || identityRef.current !== identity) return;
      setProviderSnapshots(result.snapshots);
      setProviderFetchedAt(Date.now());
      setProviderLoading(false);
    } catch {
      if (seq !== providerSeq.current || identityRef.current !== identity) return;
      setProviderLoading(false);
      setProviderError('额度信息读取失败，请稍后重试');
    }
  }, [profileId, source.identity]);

  const startProviderLoad = useCallback((force: boolean): Promise<void> => {
    const identity = source.identity;
    let flight!: NonNullable<typeof providerFlight.current>;
    const promise = performProviderLoad(force).finally(() => {
      if (providerFlight.current === flight) providerFlight.current = null;
    });
    flight = { identity, force, promise };
    providerFlight.current = flight;
    return promise;
  }, [performProviderLoad, source.identity]);

  const loadProviders = useCallback((force = false): Promise<void> => {
    if (!enabledRef.current || identityRef.current !== source.identity || !profileId) {
      return Promise.resolve();
    }
    const current = providerFlight.current;
    if (!current || current.identity !== source.identity) return startProviderLoad(force);
    if (!force || current.force) return current.promise;
    const queued = queuedProviderForce.current;
    if (queued?.identity === source.identity) return queued.promise;
    let next!: NonNullable<typeof queuedProviderForce.current>;
    const promise = current.promise.catch(() => undefined).then(() => {
      if (!enabledRef.current || identityRef.current !== source.identity || !profileId) return;
      return startProviderLoad(true);
    }).finally(() => {
      if (queuedProviderForce.current === next) queuedProviderForce.current = null;
    });
    next = { identity: source.identity, promise };
    queuedProviderForce.current = next;
    return promise;
  }, [profileId, source.identity, startProviderLoad]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      await loadTokens(false);
      if (!cancelled) timer = setTimeout(() => { void poll(); }, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, loadTokens]);

  useEffect(() => {
    if (!enabled || source.resourceRevisions.usage === 0) return;
    void loadTokens(dailyActive);
  }, [dailyActive, enabled, loadTokens, source.resourceRevisions.usage]);

  useEffect(() => {
    if (!enabled || !dailyActive) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      await loadProviders(false);
    };
    const timer = setInterval(() => {
      if (!cancelled) void refresh();
    }, PROVIDER_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [dailyActive, enabled, loadProviders]);

  return useMemo(() => ({
    enabled,
    identity: source.identity,
    rates: enabled ? rates : [],
    topToday: enabled ? topToday : [],
    ratesLoading: enabled && ratesLoading,
    ratesError: enabled ? ratesError : null,
    today: enabled ? today : null,
    daily: enabled ? daily : [],
    dailyLoading: enabled && dailyLoading,
    dailyError: enabled ? dailyError : null,
    dailyTruncated: enabled && dailyTruncated,
    providerSnapshots: enabled ? providerSnapshots : [],
    providerFetchedAt: enabled ? providerFetchedAt : null,
    providerLoading: enabled && providerLoading,
    providerError: enabled ? providerError : null,
    loadDaily: () => loadTokens(true),
    loadProviders,
  }), [
    daily, dailyError, dailyLoading, dailyTruncated, enabled, loadProviders, loadTokens,
    providerError, providerFetchedAt, providerLoading, providerSnapshots, rates, ratesError,
    ratesLoading, source.identity, today, topToday,
  ]);
}
