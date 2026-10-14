import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolHeartbeat } from './heartbeat';
import { DEFAULT_SSH_TRANSPORT_TIMING } from './config';

afterEach(() => vi.useRealTimers());

describe('heartbeat failure timing', () => {
  it('distinguishes queued input from a completed pipe write and reports timer delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let written!: () => void;
    const failed = vi.fn();
    const heartbeat = new ProtocolHeartbeat(
      DEFAULT_SSH_TRANSPORT_TIMING, () => 'ping-a', (_nonce, callback) => { written = callback; }, failed,
    );
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(100);
    written();
    heartbeat.observeReceive();
    vi.setSystemTime(50_100);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith({
      elapsedMs: 30_000, timeoutMs: 10_000, timerLagMs: 20_000,
      lastReceiveAgeMs: 29_900, writeCompleted: true, writeDelayMs: 100,
    });
    heartbeat.stop();
  });

  it('does not report a matching synchronous pong or a retired timeout', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    let heartbeat!: ProtocolHeartbeat;
    heartbeat = new ProtocolHeartbeat(DEFAULT_SSH_TRANSPORT_TIMING, () => 'ping-a', (nonce) => {
      heartbeat.acceptPong(nonce);
    }, failed);
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(failed).not.toHaveBeenCalled();
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(failed).not.toHaveBeenCalled();
  });
});
