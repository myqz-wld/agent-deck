import { describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn }) },
}));

describe('desktop Claude hook installer observer', () => {
  it('owns status-read diagnostics', async () => {
    const { desktopClaudeHookInstallerObserver: observer } = await import(
      './hook-installer-host'
    );
    const error = new Error('read failure');

    observer.statusReadFailed(error);

    expect(warn).toHaveBeenCalledWith(
      '[hook-installer] status readHookConfig failed:',
      error,
    );
  });
});
