import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureHistory: vi.fn<() => Promise<void>>(),
  ratesSince: vi.fn(() => [{ bucketKey: 'rate', outputTokens: 1 }]),
  today: vi.fn(() => [{ bucketKey: 'today', outputTokens: 2 }]),
  dailyByModel: vi.fn(() => []),
}));

vi.mock('@main/adapters/grok-build/history-usage', () => ({
  ensureGrokHistoryTokenUsage: mocks.ensureHistory,
}));
vi.mock('@main/store/token-usage-repo', () => ({
  tokenUsageRepo: {
    ratesSince: mocks.ratesSince,
    today: mocks.today,
    dailyByModel: mocks.dailyByModel,
  },
}));

import {
  isAppShutdownError,
} from '@shared/shutdown';
import {
  beginAppShutdown,
  resetAppShutdownForTests,
} from '@main/index/shutdown-state';
import {
  tokenUsageDailyHandler,
  tokenUsageRatesHandler,
  tokenUsageTopTodayHandler,
} from '../token-usage';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('token usage IPC shutdown gate', () => {
  beforeEach(() => {
    resetAppShutdownForTests();
    vi.clearAllMocks();
    mocks.ensureHistory.mockResolvedValue();
  });

  it('returns the stable shutdown signal without touching history or repositories after the gate', async () => {
    beginAppShutdown();

    await expect(tokenUsageRatesHandler({ includeGrokHistory: true }))
      .rejects.toSatisfy(isAppShutdownError);
    await expect(tokenUsageTopTodayHandler({ includeGrokHistory: true }))
      .rejects.toSatisfy(isAppShutdownError);
    await expect(tokenUsageDailyHandler({ includeGrokHistory: true }))
      .rejects.toSatisfy(isAppShutdownError);

    expect(mocks.ensureHistory).not.toHaveBeenCalled();
    expect(mocks.ratesSince).not.toHaveBeenCalled();
    expect(mocks.today).not.toHaveBeenCalled();
    expect(mocks.dailyByModel).not.toHaveBeenCalled();
  });

  it.each([
    ['rates', tokenUsageRatesHandler, mocks.ratesSince],
    ['top today', tokenUsageTopTodayHandler, mocks.today],
    ['daily', tokenUsageDailyHandler, mocks.dailyByModel],
  ] as const)(
    'fences the %s repository read when shutdown starts during history backfill',
    async (_label, handler, repositoryRead) => {
      const history = deferred();
      mocks.ensureHistory.mockReturnValueOnce(history.promise);

      const result = handler({ includeGrokHistory: true });
      await Promise.resolve();
      expect(mocks.ensureHistory).toHaveBeenCalledOnce();

      beginAppShutdown();
      history.resolve();

      await expect(result).rejects.toSatisfy(isAppShutdownError);
      expect(repositoryRead).not.toHaveBeenCalled();
    },
  );
});
