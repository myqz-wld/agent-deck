import { describe, expect, it, vi } from 'vitest';
import { readCodexUsageSnapshotInBackground } from '../usage-snapshot';

describe('readCodexUsageSnapshotInBackground', () => {
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
      env: expect.any(Object),
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

  it('returns an error snapshot and disposes the client when the read fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('auth required'));
    const dispose = vi.fn();

    const snapshot = await readCodexUsageSnapshotInBackground({
      makeClient: vi.fn(() => ({ request, dispose })),
      codexPathOverride: null,
    });

    expect(request).toHaveBeenCalledWith('account/rateLimits/read', undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      status: 'error',
      message: '额度信息读取失败，请稍后重试',
    });
  });
});
