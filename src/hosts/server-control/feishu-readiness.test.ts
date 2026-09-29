import { describe, expect, it, vi } from 'vitest';
import { waitForFeishuStartup } from './feishu-readiness';

describe('Feishu management startup readiness', () => {
  it('waits for a delayed socket listener before accepting health', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('socket absent'), { code: 'ENOENT' }))
      .mockRejectedValueOnce(Object.assign(new Error('not listening'), { code: 'ECONNREFUSED' }))
      .mockResolvedValue({ state: 'connected' });
    await expect(waitForFeishuStartup(probe, 200, 1)).resolves.toEqual({ state: 'connected' });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('keeps startup waiting bounded when the socket never appears', async () => {
    const probe = vi.fn().mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));
    const started = performance.now();
    await expect(waitForFeishuStartup(probe, 25, 5)).rejects.toThrow('readiness timed out');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each(['EACCES', 'EPERM', 'binding-invalid', 'access-denied'])('fails immediately on %s', async (code) => {
    const error = Object.assign(new Error(code), { code });
    const probe = vi.fn().mockRejectedValue(error);
    await expect(waitForFeishuStartup(probe)).rejects.toBe(error);
    expect(probe).toHaveBeenCalledOnce();
  });
});
