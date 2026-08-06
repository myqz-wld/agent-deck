import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanupGatewaySandboxSettings = vi.hoisted(() => vi.fn());
const releaseSdkClaim = vi.hoisted(() => vi.fn());
const markRecentlyDeleted = vi.hoisted(() => vi.fn());

vi.mock('./create-session/gateway-sandbox-settings', () => ({ cleanupGatewaySandboxSettings }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop Claude pending cancellation host', () => {
  it('owns wall-clock, sandbox cleanup, claims, and recently-deleted state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:34:56.000Z'));
    const { createDesktopClaudePendingCancellationHost } = await import(
      './pending-cancellation-host'
    );
    const host = createDesktopClaudePendingCancellationHost({
      releaseSdkClaim,
      markRecentlyDeleted,
    });
    const session = {} as never;

    expect(host.now()).toBe(new Date('2026-08-05T12:34:56.000Z').getTime());
    host.cleanupGatewaySandboxSettings(session);
    host.releaseSdkClaim('session');
    host.markRecentlyDeleted('session');

    expect(cleanupGatewaySandboxSettings).toHaveBeenCalledWith(session);
    expect(releaseSdkClaim).toHaveBeenCalledWith('session');
    expect(markRecentlyDeleted).toHaveBeenCalledWith('session');
  });
});
