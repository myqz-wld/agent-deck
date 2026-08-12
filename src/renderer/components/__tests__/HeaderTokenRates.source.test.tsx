// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteUsageSourceView } from '../../remote-host/use-remote-usage-source';

const poll = vi.hoisted(() => vi.fn());
const localStore = vi.hoisted(() => vi.fn((selector: (state: {
  topToday: never[];
  rates: never[];
  liveBySession: Record<string, never>;
}) => unknown) => selector({ topToday: [], rates: [], liveBySession: {} })));
vi.mock('../../hooks/use-token-rates-poll', () => ({ useTokenRatesPoll: poll }));
vi.mock('../../hooks/use-container-width', () => ({ useContainerWidth: () => 800 }));
vi.mock('../../stores/token-usage-store', () => ({ useTokenUsageStore: localStore }));

import { HeaderTokenRates } from '../HeaderTokenRates';

afterEach(() => {
  cleanup();
  poll.mockClear();
  localStore.mockClear();
});

function remoteUsage(enabled: boolean): RemoteUsageSourceView {
  return {
    enabled,
    identity: 'remote-a:core-a:1',
    rates: [],
    topToday: [],
    ratesLoading: false,
    ratesError: null,
    today: '2026-08-10',
    daily: [],
    dailyLoading: false,
    dailyError: null,
    dailyTruncated: false,
    providerSnapshots: [],
    providerFetchedAt: null,
    providerLoading: false,
    providerError: null,
    loadDaily: vi.fn(async () => undefined),
    loadProviders: vi.fn(async () => undefined),
  };
}

describe('HeaderTokenRates source isolation', () => {
  it('polls Local usage only while Local is selected', () => {
    render(<HeaderTokenRates />);
    expect(poll).toHaveBeenCalledWith(false, 2500, true);
    expect(localStore).toHaveBeenCalledTimes(3);
  });

  it('never falls back to Local usage for an unsupported or loading Remote Core', () => {
    render(<HeaderTokenRates remoteUsage={remoteUsage(false)} />);
    expect(poll).not.toHaveBeenCalled();
    expect(localStore).not.toHaveBeenCalled();
  });
});
