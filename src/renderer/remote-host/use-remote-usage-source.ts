import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { USAGE_DAILY_MAX_ITEMS } from '@contracts/index';
import type {
  ProviderUsageSnapshot,
  TokenDailyRow,
  TokenRateRow,
} from '@shared/types';
import type { RemoteSessionSourceView } from './source-types';

const POLL_MS = 2_500;

export interface RemoteUsageSourceView {
  enabled: boolean;
  identity: string;
  rates: TokenRateRow[];
  topToday: TokenRateRow[];
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
  const enabled = remoteMode && source.usable && source.capabilities.has('usage');
  const profileId = source.profile?.id ?? null;
  const identityRef = useRef(source.identity);
  identityRef.current = source.identity;
  const [rates, setRates] = useState<TokenRateRow[]>([]);
  const [topToday, setTopToday] = useState<TokenRateRow[]>([]);
  const [today, setToday] = useState<string | null>(null);
  const [daily, setDaily] = useState<TokenDailyRow[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [dailyTruncated, setDailyTruncated] = useState(false);
  const [dailyLoaded, setDailyLoaded] = useState(false);
  const [providerSnapshots, setProviderSnapshots] = useState<ProviderUsageSnapshot[]>([]);
  const [providerFetchedAt, setProviderFetchedAt] = useState<number | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const rateSeq = useRef(0);
  const dailySeq = useRef(0);
  const providerSeq = useRef(0);
  const tokenRequestSeq = useRef(0);
  const appliedRateRequestSeq = useRef(0);

  useEffect(() => {
    rateSeq.current += 1;
    dailySeq.current += 1;
    providerSeq.current += 1;
    appliedRateRequestSeq.current = tokenRequestSeq.current;
    setRates([]);
    setTopToday([]);
    setToday(null);
    setDaily([]);
    setDailyLoading(false);
    setDailyError(null);
    setDailyTruncated(false);
    setDailyLoaded(false);
    setProviderSnapshots([]);
    setProviderFetchedAt(null);
    setProviderLoading(false);
    setProviderError(null);
  }, [enabled, source.identity]);

  const loadTokens = useCallback(async (includeDaily: boolean): Promise<void> => {
    if (!enabled || !profileId) return;
    const identity = source.identity;
    const sequence = includeDaily ? dailySeq : rateSeq;
    const seq = ++sequence.current;
    const requestSeq = ++tokenRequestSeq.current;
    if (includeDaily) {
      setDailyLoaded(true);
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
      }
      if (includeDaily) {
        setDaily(result.daily);
        setDailyTruncated(result.dailyTruncated);
        setDailyLoading(false);
      }
    } catch {
      if (seq !== sequence.current || identityRef.current !== identity) return;
      if (includeDaily) {
        setDailyLoading(false);
        setDailyError('Token 使用记录读取失败，请稍后重试');
      }
    }
  }, [enabled, profileId, source.identity]);

  const loadProviders = useCallback(async (force = false): Promise<void> => {
    if (!enabled || !profileId) return;
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
  }, [enabled, profileId, source.identity]);

  useEffect(() => {
    if (!enabled) return;
    void loadTokens(false);
    const timer = setInterval(() => { void loadTokens(false); }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, loadTokens]);

  const observedRevision = useRef({ identity: source.identity, revision: source.dataRevision });
  useEffect(() => {
    const observed = observedRevision.current;
    if (observed.identity !== source.identity) {
      observedRevision.current = { identity: source.identity, revision: source.dataRevision };
      return;
    }
    if (observed.revision === source.dataRevision) return;
    observedRevision.current = { identity: source.identity, revision: source.dataRevision };
    if (enabled) void loadTokens(dailyActive && dailyLoaded);
  }, [dailyActive, dailyLoaded, enabled, loadTokens, source.dataRevision, source.identity]);

  return useMemo(() => ({
    enabled,
    identity: source.identity,
    rates,
    topToday,
    today,
    daily,
    dailyLoading,
    dailyError,
    dailyTruncated,
    providerSnapshots,
    providerFetchedAt,
    providerLoading,
    providerError,
    loadDaily: () => loadTokens(true),
    loadProviders,
  }), [
    daily, dailyError, dailyLoading, dailyTruncated, enabled, loadProviders, loadTokens,
    providerError, providerFetchedAt, providerLoading, providerSnapshots, rates, source.identity,
    today, topToday,
  ]);
}
