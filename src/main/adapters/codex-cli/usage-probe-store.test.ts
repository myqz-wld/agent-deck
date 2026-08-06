import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCodexUsageProbeStore,
  type CodexUsageClient,
} from './usage-probe-store';

function successfulClient(usedPercent: number): CodexUsageClient & {
  dispose: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
} {
  return {
    request: vi.fn().mockResolvedValue({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
      },
    }),
    dispose: vi.fn(),
  };
}

describe('Codex usage probe store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads and disposes a transient client', async () => {
    const client = successfulClient(31);
    const store = createCodexUsageProbeStore();

    const snapshot = await store.read({
      clientKey: 'transient',
      makeClient: () => client,
      cacheClient: false,
      timeoutMs: 15_000,
      idleDisposeMs: 60_000,
    });

    expect(client.request).toHaveBeenCalledWith(
      'account/rateLimits/read',
      undefined,
    );
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(snapshot.status).toBe('ok');
    expect(snapshot.windows[0]?.usedPercent).toBe(31);
  });

  it('maps expected provider failures without exposing raw errors', async () => {
    const store = createCodexUsageProbeStore();
    const unavailable = await store.read({
      clientKey: 'unavailable',
      makeClient: () => ({
        request: vi.fn().mockRejectedValue(
          new Error('authentication required Bearer private-token'),
        ),
        dispose: vi.fn(),
      }),
      cacheClient: false,
      timeoutMs: 15_000,
      idleDisposeMs: 60_000,
    });

    expect(unavailable).toMatchObject({
      status: 'unavailable',
      message: 'Codex 额度信息暂不可读，请确认 Codex 已登录且网络可用',
    });
    expect(JSON.stringify(unavailable)).not.toContain('private-token');
  });

  it('reuses one keyed client and retires it after the idle bound', async () => {
    vi.useFakeTimers();
    const client = successfulClient(41);
    const makeClient = vi.fn(() => client);
    const store = createCodexUsageProbeStore();
    const input = {
      clientKey: '/opt/codex\n/probe-cwd',
      makeClient,
      cacheClient: true,
      timeoutMs: 15_000,
      idleDisposeMs: 10,
    };

    await store.read(input);
    await store.read(input);
    expect(makeClient).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('invalidates a timed-out cached client before a later retry', async () => {
    const timedOut = {
      request: vi.fn(() => new Promise<never>(() => undefined)),
      dispose: vi.fn(),
    };
    const recovered = successfulClient(44);
    const makeClient = vi
      .fn()
      .mockReturnValueOnce(timedOut)
      .mockReturnValueOnce(recovered);
    const store = createCodexUsageProbeStore();
    const input = {
      clientKey: 'same-key',
      makeClient,
      cacheClient: true,
      timeoutMs: 1,
      idleDisposeMs: 60_000,
    };

    expect((await store.read(input)).status).toBe('error');
    expect(timedOut.dispose).toHaveBeenCalledOnce();
    expect((await store.read(input)).windows[0]?.usedPercent).toBe(44);
    expect(makeClient).toHaveBeenCalledTimes(2);
    store.invalidate();
  });
});
