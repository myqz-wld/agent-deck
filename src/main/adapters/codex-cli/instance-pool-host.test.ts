import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ dispose: vi.fn() })),
  getSetting: vi.fn(() => '/bin/codex'),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('./app-server/client-diagnostics', () => ({
  createDesktopCodexAppServerClient: mocks.createClient,
}));

describe('desktop Codex instance pool host', () => {
  it('owns settings, process environment, and the desktop client factory', async () => {
    const { desktopCodexInstancePoolHost: host } = await import('./instance-pool-host');
    const previous = process.env.AGENT_DECK_POOL_HOST_TEST;
    process.env.AGENT_DECK_POOL_HOST_TEST = 'visible';
    try {
      expect(host.readCodexCliPath()).toBe('/bin/codex');
      expect(host.snapshotProcessEnv()).toMatchObject({
        AGENT_DECK_POOL_HOST_TEST: 'visible',
      });
      host.createClient({ codexPathOverride: null, config: null, env: {} });
      expect(mocks.createClient).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_POOL_HOST_TEST;
      else process.env.AGENT_DECK_POOL_HOST_TEST = previous;
    }
  });
});
