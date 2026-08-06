import { describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
vi.mock('@main/event-bus', () => ({ eventBus: { emit } }));

describe('desktop Grok live token-rate observer', () => {
  it('owns the typed application event-bus publication', async () => {
    const { desktopGrokLiveRateObserver: observer } = await import('./live-token-rate-host');
    const event = { sessionId: 'session', bucketKey: 'grok', tps: 1, ts: 10 };
    observer.emitTokenRateTick(event);
    expect(emit).toHaveBeenCalledWith('token-rate-tick', event);
  });
});
