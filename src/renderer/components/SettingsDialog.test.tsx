// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { SettingsDialog } from './SettingsDialog';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('SettingsDialog adapter views', () => {
  it('includes a Grok Build view without inventing a terminal Hook', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus: vi.fn().mockResolvedValue({
          installed: false,
          scope: 'user',
          path: '',
        }),
      },
    });

    render(<SettingsDialog open onClose={vi.fn()} />);
    const grokTab = await screen.findByRole('tab', { name: 'Grok Build' });
    fireEvent.click(grokTab);

    expect(screen.getByText('Grok Build 配置')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ACP 认证' })).toBeTruthy();
    expect(screen.queryByText(/Grok Build 终端 Hook/)).toBeNull();
  });
});
