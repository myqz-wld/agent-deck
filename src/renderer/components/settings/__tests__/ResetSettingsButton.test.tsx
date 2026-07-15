// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { ResetSettingsButton } from '../ResetSettingsButton';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('ResetSettingsButton', () => {
  it('confirms and resets preferences without rotating installation tokens', async () => {
    const confirmDialog = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog },
    });
    const update = vi.fn().mockResolvedValue(undefined);
    render(<ResetSettingsButton busy={false} update={update} />);

    fireEvent.click(screen.getByRole('button', { name: '重置到默认配置' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: '重置到默认配置', destructive: true }),
    );
    const patch = update.mock.calls[0]![0];
    expect(patch).toMatchObject({
      summaryMaxConcurrent: DEFAULT_SETTINGS.summaryMaxConcurrent,
      claudeCodeSandbox: DEFAULT_SETTINGS.claudeCodeSandbox,
      codexSandbox: DEFAULT_SETTINGS.codexSandbox,
    });
    expect(patch).not.toHaveProperty('hookServerToken');
    expect(patch).not.toHaveProperty('mcpServerToken');
  });

  it('does nothing when reset is cancelled', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn().mockResolvedValue(false) },
    });
    const update = vi.fn();
    render(<ResetSettingsButton busy={false} update={update} />);

    fireEvent.click(screen.getByRole('button', { name: '重置到默认配置' }));
    await waitFor(() => expect(window.api.confirmDialog).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });
});
