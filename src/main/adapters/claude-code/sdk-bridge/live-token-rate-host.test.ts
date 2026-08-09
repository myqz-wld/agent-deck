import { describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('@main/event-bus', () => ({ eventBus: { emit } }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get } }));

describe('desktop Claude live token-rate host', () => {
  it('owns model lookup precedence and typed event publication', async () => {
    get.mockImplementation((sessionId: string) =>
      sessionId === 'application' ? { model: null } : { model: 'claude-fallback' });
    const { desktopClaudeLiveRateHost: host } = await import('./live-token-rate-host');
    expect(host.resolveModel('application', 'fallback')).toBe('claude-fallback');

    const event = { sessionId: 'application', bucketKey: 'claude', tps: 3, ts: 10 };
    host.emitTokenRateTick(event);
    expect(emit).toHaveBeenCalledWith('token-rate-tick', event);
  });
});
