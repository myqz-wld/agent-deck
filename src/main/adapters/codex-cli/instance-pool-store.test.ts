import { describe, expect, it, vi } from 'vitest';
import { createCodexInstancePoolStore } from './instance-pool-store';

function client() {
  return { dispose: vi.fn() };
}

describe('Codex instance pool store', () => {
  it.each([null, undefined, '', '  \t  '])(
    'normalizes an absent path and reuses one instance: %j',
    (configuredPath) => {
      const created = client();
      const createInstance = vi.fn(() => created);
      const pool = createCodexInstancePoolStore(createInstance);

      expect(pool.get(configuredPath)).toBe(created);
      expect(pool.get(null)).toBe(created);
      expect(createInstance).toHaveBeenCalledOnce();
      expect(createInstance).toHaveBeenCalledWith(null);
      expect(created.dispose).not.toHaveBeenCalled();
    },
  );

  it('trims path identities and retires the prior instance on change', () => {
    const first = client();
    const second = client();
    const createInstance = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const pool = createCodexInstancePoolStore(createInstance);

    expect(pool.get('  /opt/codex-a  ')).toBe(first);
    expect(pool.get('/opt/codex-a')).toBe(first);
    expect(pool.get('/opt/codex-b')).toBe(second);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(createInstance.mock.calls).toEqual([
      ['/opt/codex-a'],
      ['/opt/codex-b'],
    ]);
  });

  it('invalidates eagerly and recreates the same configured identity', () => {
    const first = client();
    const second = client();
    const createInstance = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const pool = createCodexInstancePoolStore(createInstance);

    expect(pool.get('/opt/codex')).toBe(first);
    pool.invalidate();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(pool.get('/opt/codex')).toBe(second);
  });

  it('retries construction and preserves the old cache when retirement throws', () => {
    const constructionError = new Error('construction failed');
    const recovered = client();
    const createAfterFailure = vi
      .fn()
      .mockImplementationOnce(() => {
        throw constructionError;
      })
      .mockReturnValueOnce(recovered);
    const retryingPool = createCodexInstancePoolStore(createAfterFailure);

    expect(() => retryingPool.get('/opt/codex')).toThrow(constructionError);
    expect(retryingPool.get('/opt/codex')).toBe(recovered);
    expect(createAfterFailure).toHaveBeenCalledTimes(2);

    const retirementError = new Error('retirement failed');
    const retained = {
      dispose: vi.fn(() => {
        throw retirementError;
      }),
    };
    const neverCreated = client();
    const createWithRetirementFailure = vi
      .fn()
      .mockReturnValueOnce(retained)
      .mockReturnValueOnce(neverCreated);
    const fencedPool = createCodexInstancePoolStore(
      createWithRetirementFailure,
    );

    expect(fencedPool.get('/opt/old')).toBe(retained);
    expect(() => fencedPool.get('/opt/new')).toThrow(retirementError);
    expect(fencedPool.get('/opt/old')).toBe(retained);
    expect(createWithRetirementFailure).toHaveBeenCalledOnce();
  });
});
