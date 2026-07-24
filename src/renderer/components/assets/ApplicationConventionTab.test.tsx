// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApplicationConventionTab } from './ApplicationConventionTab';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('ApplicationConventionTab', () => {
  it('offers Claude, Codex, and Grok views with the Grok custom-copy editor', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getClaudeMd: vi.fn().mockResolvedValue({ content: '# claude', isCustom: false }),
        getCodexAgentsMd: vi.fn().mockResolvedValue({ content: '# codex', isCustom: false }),
        getGrokAgentsMd: vi.fn().mockResolvedValue({ content: '# grok', isCustom: true }),
        saveClaudeMd: vi.fn(),
        saveCodexAgentsMd: vi.fn(),
        saveGrokAgentsMd: vi.fn(),
        resetClaudeMd: vi.fn(),
        resetCodexAgentsMd: vi.fn(),
        resetGrokAgentsMd: vi.fn(),
        confirmDialog: vi.fn(),
      },
    });

    render(<ApplicationConventionTab onDirtyChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));

    expect(await screen.findByDisplayValue('# grok')).toBeTruthy();
    expect(screen.getByText(/GROK_AGENTS\.md/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeTruthy();
  });
});
