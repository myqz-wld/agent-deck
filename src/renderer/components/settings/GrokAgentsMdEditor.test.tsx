// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GrokAgentsMdEditor } from './GrokAgentsMdEditor';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('GrokAgentsMdEditor', () => {
  it('restores only the app-owned custom copy to the packaged default', async () => {
    const resetGrokAgentsMd = vi.fn().mockResolvedValue({
      ok: true,
      content: '# bundled',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getGrokAgentsMd: vi.fn().mockResolvedValue({
          content: '# custom',
          isCustom: true,
        }),
        saveGrokAgentsMd: vi.fn(),
        resetGrokAgentsMd,
        confirmDialog: vi.fn().mockResolvedValue(true),
      },
    });

    render(<GrokAgentsMdEditor />);
    await screen.findByDisplayValue('# custom');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));

    await waitFor(() => expect(resetGrokAgentsMd).toHaveBeenCalledOnce());
    expect(screen.getByDisplayValue('# bundled')).toBeTruthy();
    expect(screen.getByText(/不会写入用户级 Grok 配置/)).toBeTruthy();
  });

  it('does not show restore-default while using the packaged baseline', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getGrokAgentsMd: vi.fn().mockResolvedValue({
          content: '# bundled',
          isCustom: false,
        }),
        saveGrokAgentsMd: vi.fn(),
        resetGrokAgentsMd: vi.fn(),
        confirmDialog: vi.fn(),
      },
    });

    render(<GrokAgentsMdEditor />);
    await screen.findByDisplayValue('# bundled');
    expect(screen.queryByRole('button', { name: '恢复默认' })).toBeNull();
  });
});
