// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GrokAuthenticationSection } from '../GrokAuthenticationSection';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('GrokAuthenticationSection', () => {
  it('shows the authenticated ACP method without exposing credentials', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        probeGrokAuth: vi.fn().mockResolvedValue({
          ok: true,
          methodId: 'xai.api_key',
          methods: [
            { id: 'xai.api_key', name: 'API key', type: 'env_var' },
            { id: 'cached_token', name: 'Cached login', type: 'agent' },
          ],
          usedLoginShell: true,
        }),
      },
    });

    render(<GrokAuthenticationSection />);
    fireEvent.click(screen.getByRole('button', { name: '检测' }));

    expect(await screen.findByText(/认证可用/)).toBeTruthy();
    expect(screen.getAllByText(/xai\.api_key/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ACP 提供：xai\.api_key、cached_token/)).toBeTruthy();
    expect(screen.getByText(/不会保存或显示 API Key/)).toBeTruthy();
  });
});
