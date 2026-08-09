import { describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
const safeDiagnostic = vi.hoisted(() => vi.fn((value) => value));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/host-home',
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn, info: vi.fn() }) },
}));
vi.mock('@main/utils/safe-diagnostic', () => ({ safeDiagnostic }));
vi.mock('@main/utils/run-context', () => ({ getProcessRunId: () => 'host-run' }));

describe('desktop Claude sandbox host', () => {
  it('owns the home directory and redacted bounded state observation', async () => {
    const { desktopClaudeSandboxHost: host } = await import('./sandbox-config-host');

    expect(host.homeDir()).toBe('/host-home');
    host.observeState('invalid-mode');

    expect(safeDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'claude-configuration-state',
      operation: 'sandbox',
      state: 'invalid-mode',
      runId: 'host-run',
    }));
    expect(warn).toHaveBeenCalledWith(
      'Claude configuration state degraded',
      expect.objectContaining({ state: 'invalid-mode' }),
    );
  });
});
