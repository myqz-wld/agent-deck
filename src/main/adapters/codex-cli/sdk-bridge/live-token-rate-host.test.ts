import { describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('@main/event-bus', () => ({ eventBus: { emit } }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get } }));

describe('desktop Codex live token-rate host', () => {
  it('owns model lookup precedence and typed event publication', async () => {
    get.mockImplementation((sessionId: string) =>
      sessionId === 'application' ? { model: null } : { model: 'codex-fallback' });
    const { desktopCodexLiveRateHost: host } = await import('./live-token-rate-host');
    expect(host.resolveModel('application', 'fallback')).toBe('codex-fallback');

    const event = { sessionId: 'application', bucketKey: 'codex', tps: 2, ts: 10 };
    host.emitTokenRateTick(event);
    expect(emit).toHaveBeenCalledWith('token-rate-tick', event);
  });
});
