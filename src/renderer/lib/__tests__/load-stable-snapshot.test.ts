import { describe, expect, it, vi } from 'vitest';
import { loadStableSnapshot } from '../load-stable-snapshot';

describe('loadStableSnapshot', () => {
  it('discards a response when a live mutation changed the version and retries', async () => {
    let version = 0;
    const apply = vi.fn();
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(async () => {
        version++;
        return 'stale';
      })
      .mockResolvedValueOnce('fresh');

    await expect(
      loadStableSnapshot({
        readVersion: () => version,
        load,
        apply,
      }),
    ).resolves.toBe('applied');

    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('fresh');
  });

  it('never applies a snapshot that stayed unstable for every attempt', async () => {
    let version = 0;
    const apply = vi.fn();

    await expect(
      loadStableSnapshot({
        readVersion: () => version,
        load: async () => {
          version++;
          return `snapshot-${version}`;
        },
        apply,
        maxAttempts: 3,
      }),
    ).resolves.toBe('unstable');

    expect(apply).not.toHaveBeenCalled();
  });

  it('stops without applying after cancellation', async () => {
    let cancelled = false;
    const apply = vi.fn();

    await expect(
      loadStableSnapshot({
        readVersion: () => 0,
        load: async () => {
          cancelled = true;
          return 'snapshot';
        },
        apply,
        isCancelled: () => cancelled,
      }),
    ).resolves.toBe('cancelled');

    expect(apply).not.toHaveBeenCalled();
  });
});
