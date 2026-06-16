import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSdkBridge } from '../sdk-bridge';
import { readClaudeUsageSnapshotInBackground } from '../usage-snapshot';

vi.mock('../usage-snapshot', () => ({
  readClaudeUsageSnapshotInBackground: vi.fn().mockResolvedValue({
    provider: 'claude-code',
    label: 'Claude',
    status: 'ok',
    windows: [],
    updatedAt: 123,
  }),
}));

function makeBridge(): ClaudeSdkBridge {
  return new ClaudeSdkBridge({ emit: vi.fn() });
}

function setClaudeSessions(bridge: ClaudeSdkBridge, sessions: unknown[]): void {
  (bridge as unknown as { sessions: Map<string, unknown> }).sessions = new Map(
    sessions.map((session, index) => [`sid-${index}`, session]),
  );
}

describe('ClaudeSdkBridge getUsageSnapshot', () => {
  beforeEach(() => {
    vi.mocked(readClaudeUsageSnapshotInBackground).mockClear();
  });

  it('uses the background usage probe when no live query exists', async () => {
    const snapshot = await makeBridge().getUsageSnapshot();

    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      status: 'ok',
    });
    expect(readClaudeUsageSnapshotInBackground).toHaveBeenCalledTimes(1);
  });

  it('skips sessions that are already closing and uses the probe', async () => {
    const bridge = makeBridge();
    const usage = vi.fn();
    setClaudeSessions(bridge, [
      {
        expectedClose: true,
        query: {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
        },
      },
    ]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(usage).not.toHaveBeenCalled();
    expect(snapshot.status).toBe('ok');
    expect(readClaudeUsageSnapshotInBackground).toHaveBeenCalledTimes(1);
  });

  it('reads usage through an already live SDK query', async () => {
    const bridge = makeBridge();
    const usage = vi.fn().mockResolvedValue({
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {},
      },
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 22, resets_at: null },
        seven_day: { utilization: 44, resets_at: null },
      },
      behaviors: null,
    });
    setClaudeSessions(bridge, [
      {
        expectedClose: false,
        query: {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
        },
      },
    ]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(usage).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      status: 'ok',
    });
    expect(snapshot.windows.map((w) => w.usedPercent)).toEqual([22, 44]);
    expect(readClaudeUsageSnapshotInBackground).not.toHaveBeenCalled();
  });
});
