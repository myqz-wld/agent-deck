import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteReadCache } from './remote-read-cache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('remote read projections', () => {
  it('bounds entries by recency and expires data without extending its age on access', () => {
    vi.useFakeTimers();
    const cache = new RemoteReadCache<number>(2, 1000);
    cache.set('a', 1); cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeNull();
    vi.advanceTimersByTime(900);
    expect(cache.get('a')).toBe(1);
    vi.advanceTimersByTime(101);
    expect(cache.get('a')).toBeNull();
  });

  it('shares concurrent reads but never overwrites an accepted write or a reconnected read', async () => {
    const cache = new RemoteReadCache<string>();
    const old = deferred<string>();
    const read = vi.fn(() => old.promise);
    const first = cache.read('a', read);
    expect(cache.read('a', read)).toBe(first);
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    cache.set('a', 'saved');
    old.resolve('stale'); await first;
    expect(cache.get('a')).toBe('saved');
    const retired = deferred<string>();
    const pending = cache.read('a', () => retired.promise);
    cache.clear();
    await cache.read('a', async () => 'reconnected');
    retired.resolve('old connection'); await pending;
    expect(cache.get('a')).toBe('reconnected');
  });

  it('allows a fresh read after failure or invalidation', async () => {
    const cache = new RemoteReadCache<string>();
    await expect(cache.read('a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await cache.read('a', async () => 'ready')).toBe('ready');
    const old = deferred<string>();
    const pending = cache.read('a', () => old.promise);
    cache.delete('a');
    await cache.read('a', async () => 'fresh');
    old.resolve('retired'); await pending;
    expect(cache.get('a')).toBe('fresh');
  });
});
