import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<{ name: string; payload: unknown }>);

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: (name: string, payload: unknown) => emitted.push({ name, payload }),
  },
}));

import {
  beginGrokLiveTokenRate,
  clearGrokLiveTokenRate,
  completeGrokLiveTokenRate,
  handleGrokTextForLiveRate,
} from '../live-token-rate';

describe('Grok live token rate', () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it('emits an estimated tick while text chunks stream and an exact tick on completion', () => {
    const owner = { liveRate: null };
    beginGrokLiveTokenRate(owner, 'session-1', 'claude-fable-5', 1_000);
    handleGrokTextForLiveRate(owner, 'a'.repeat(120), 1_000);
    handleGrokTextForLiveRate(owner, 'b'.repeat(120), 2_000);
    completeGrokLiveTokenRate(owner, 80, 2_100);

    const ticks = emitted.filter((entry) => entry.name === 'token-rate-tick');
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]?.payload).toMatchObject({ sessionId: 'session-1', bucketKey: 'fable-5' });
    expect(ticks.at(-1)?.payload).toMatchObject({ tps: 80 });
    expect(owner.liveRate).toBeNull();
  });

  it('uses Grok api duration when a turn has only one visible text timestamp', () => {
    const owner = { liveRate: null };
    beginGrokLiveTokenRate(owner, 'session-2', 'grok-4.5', 1_000);
    handleGrokTextForLiveRate(owner, 'single chunk', 1_000);
    completeGrokLiveTokenRate(owner, 25, 1_100, 500);

    expect(emitted.at(-1)?.payload).toMatchObject({
      sessionId: 'session-2',
      bucketKey: 'grok-4.5',
      tps: 50,
    });
  });

  it('clears the renderer display state on cancellation', () => {
    const owner = { liveRate: null };
    beginGrokLiveTokenRate(owner, 'session-3', null, 1_000);
    clearGrokLiveTokenRate(owner, 1_500);

    expect(emitted.at(-1)?.payload).toMatchObject({
      sessionId: 'session-3',
      done: true,
      tps: 0,
    });
  });
});
