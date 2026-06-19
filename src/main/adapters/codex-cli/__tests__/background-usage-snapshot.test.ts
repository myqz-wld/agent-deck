import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateCodexUsageSnapshotClient,
  readCodexUsageSnapshotInBackground,
} from '../usage-snapshot';

describe('readCodexUsageSnapshotInBackground', () => {
  afterEach(() => {
    invalidateCodexUsageSnapshotClient();
    vi.useRealTimers();
  });

  it('reads account rate limits through a transient client only', async () => {
    const request = vi.fn().mockResolvedValue({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 52, windowDurationMins: 10080, resetsAt: null },
      },
    });
    const dispose = vi.fn();
    const makeClient = vi.fn(() => ({ request, dispose }));

    const snapshot = await readCodexUsageSnapshotInBackground({
      makeClient,
      codexPathOverride: '/opt/codex',
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
    });

    expect(makeClient).toHaveBeenCalledWith({
      codexPathOverride: '/opt/codex',
      env: expect.objectContaining({ AGENT_DECK_ORIGIN: 'sdk' }),
      cwd: '/agent-deck/userData/provider-usage-probe-cwd',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('account/rateLimits/read', undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      status: 'ok',
    });
    expect(snapshot.windows.map((w) => w.usedPercent)).toEqual([31, 52]);
  });

  it('returns unavailable and disposes a transient client when the quota endpoint fails', async () => {
    const request = vi.fn().mockRejectedValue(
      new Error(
        'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)',
      ),
    );
    const dispose = vi.fn();

    const snapshot = await readCodexUsageSnapshotInBackground({
      makeClient: vi.fn(() => ({ request, dispose })),
      codexPathOverride: null,
    });

    expect(request).toHaveBeenCalledWith('account/rateLimits/read', undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      status: 'unavailable',
      message: 'Codex 额度信息暂不可读，请确认 Codex 已登录且网络可用',
    });
  });

  it('reuses the cached app-server client for background quota reads', async () => {
    const request = vi.fn().mockResolvedValue({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    });
    const dispose = vi.fn();
    const makeClient = vi.fn(() => ({ request, dispose }));

    const first = await readCodexUsageSnapshotInBackground({
      makeClient,
      cacheClient: true,
      idleDisposeMs: 60_000,
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
    });
    const second = await readCodexUsageSnapshotInBackground({
      makeClient,
      cacheClient: true,
      idleDisposeMs: 60_000,
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
    });

    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
    expect(first.windows[0]?.usedPercent).toBe(41);
    expect(second.windows[0]?.usedPercent).toBe(41);

    invalidateCodexUsageSnapshotClient();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cached app-server client on timeout', async () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const makeClient = vi
      .fn()
      .mockReturnValueOnce({
        request: vi.fn(() => new Promise(() => undefined)),
        dispose: firstDispose,
      })
      .mockReturnValueOnce({
        request: vi.fn().mockResolvedValue({
          rateLimits: {
            limitId: 'codex',
            primary: { usedPercent: 44, windowDurationMins: 300, resetsAt: null },
            secondary: null,
          },
        }),
        dispose: secondDispose,
      });

    const first = await readCodexUsageSnapshotInBackground({
      makeClient,
      cacheClient: true,
      timeoutMs: 1,
      idleDisposeMs: 60_000,
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
    });
    const second = await readCodexUsageSnapshotInBackground({
      makeClient,
      cacheClient: true,
      idleDisposeMs: 60_000,
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
    });

    expect(first.status).toBe('error');
    expect(makeClient).toHaveBeenCalledTimes(2);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(second.windows[0]?.usedPercent).toBe(44);
    expect(secondDispose).not.toHaveBeenCalled();
  });

  it('clears the cached client idle timer while a reused quota read is in flight', async () => {
    vi.useFakeTimers();
    type RateLimitsResponse = {
      rateLimits: {
        limitId: string;
        primary: { usedPercent: number; windowDurationMins: number; resetsAt: null };
        secondary: null;
      };
    };
    let resolveSecond: (value: RateLimitsResponse) => void = () => {
      throw new Error('test resolver not initialized');
    };
    const dispose = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const makeClient = vi.fn(() => ({ request, dispose }));

    await readCodexUsageSnapshotInBackground({
      makeClient,
      cacheClient: true,
      idleDisposeMs: 10,
      timeoutMs: 1_000,
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
    });

    const secondPromise = readCodexUsageSnapshotInBackground({
      makeClient,
      cacheClient: true,
      idleDisposeMs: 10,
      timeoutMs: 1_000,
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(dispose).not.toHaveBeenCalled();

    resolveSecond({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    });
    const second = await secondPromise;
    expect(second.windows[0]?.usedPercent).toBe(42);

    await vi.advanceTimersByTimeAsync(10);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
