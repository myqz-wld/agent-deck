import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ marker: 'client' })),
  getProbeCwd: vi.fn(() => '/usage-probe'),
  getSetting: vi.fn(() => '/bin/codex'),
}));

vi.mock('@main/paths', () => ({
  getProviderUsageProbeCwd: mocks.getProbeCwd,
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('./app-server/client-diagnostics', () => ({
  createDesktopCodexAppServerClient: mocks.createClient,
}));

describe('desktop Codex usage snapshot host', () => {
  it('owns settings, probe cwd, process environment, and the desktop factory', async () => {
    const { desktopCodexUsageSnapshotHost: host } = await import('./usage-snapshot-host');
    const previous = process.env.AGENT_DECK_USAGE_HOST_TEST;
    process.env.AGENT_DECK_USAGE_HOST_TEST = 'visible';
    try {
      expect(host.readCodexCliPath()).toBe('/bin/codex');
      expect(host.readProbeCwd()).toBe('/usage-probe');
      expect(host.snapshotProcessEnv()).toMatchObject({
        AGENT_DECK_USAGE_HOST_TEST: 'visible',
      });
      host.createClient({
        codexPathOverride: null,
        config: null,
        cwd: '/usage-probe',
        env: {},
      });
      expect(mocks.createClient).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_USAGE_HOST_TEST;
      else process.env.AGENT_DECK_USAGE_HOST_TEST = previous;
    }
  });
});
