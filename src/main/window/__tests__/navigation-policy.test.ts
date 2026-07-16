import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  allowedExternalNavigationUrl,
  installWindowNavigationPolicy,
} from '../navigation-policy';

describe('window navigation policy', () => {
  it('allows only links that are safe to hand to the operating system', () => {
    expect(allowedExternalNavigationUrl('https://example.com/path')).toBe(
      'https://example.com/path',
    );
    expect(allowedExternalNavigationUrl('mailto:user@example.com')).toBe(
      'mailto:user@example.com',
    );
    expect(allowedExternalNavigationUrl('file:///tmp/source.ts:5')).toBeNull();
    expect(allowedExternalNavigationUrl('javascript:alert(1)')).toBeNull();
    expect(allowedExternalNavigationUrl('not a url')).toBeNull();
  });

  it('blocks renderer replacement and opens approved targets externally', async () => {
    let navigate: ((event: { preventDefault: () => void }, url: string) => void) | null = null;
    let openWindow: ((details: { url: string }) => { action: 'deny' }) | null = null;
    const webContents = {
      on: vi.fn((_event, listener) => {
        navigate = listener;
      }),
      setWindowOpenHandler: vi.fn((handler) => {
        openWindow = handler;
      }),
    } as unknown as Pick<WebContents, 'on' | 'setWindowOpenHandler'>;
    const openExternal = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    installWindowNavigationPolicy(webContents, openExternal);

    navigate!({ preventDefault }, 'file:///tmp/source.ts:5');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();

    navigate!({ preventDefault }, 'https://example.com/docs');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(openWindow!({ url: 'mailto:user@example.com' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('mailto:user@example.com');
    await Promise.resolve();
  });
});
