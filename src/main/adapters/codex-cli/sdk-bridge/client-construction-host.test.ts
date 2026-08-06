import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getAll: vi.fn(() => ({ marker: 'settings' })),
  getSetting: vi.fn(() => '/bin/codex'),
  skillRoots: vi.fn(() => ['/skills']),
}));

vi.mock('@main/codex-config/skills-installer', () => ({
  getCodexSkillExtraRootsForSession: mocks.skillRoots,
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting, getAll: mocks.getAll },
}));
vi.mock('../app-server/client-diagnostics', () => ({
  createDesktopCodexAppServerClient: mocks.createClient,
}));

describe('desktop Codex client construction host', () => {
  it('owns settings, skills, process environment, and the desktop factory', async () => {
    const { desktopCodexClientConstructionHost: host } = await import('./client-construction-host');
    const previous = process.env.AGENT_DECK_CLIENT_HOST_TEST;
    process.env.AGENT_DECK_CLIENT_HOST_TEST = 'visible';
    try {
      expect(host.readCodexCliPath()).toBe('/bin/codex');
      expect(host.readSettings()).toEqual({ marker: 'settings' });
      expect(host.readSkillExtraRoots()).toEqual(['/skills']);
      expect(host.snapshotProcessEnv()).toMatchObject({
        AGENT_DECK_CLIENT_HOST_TEST: 'visible',
      });
      host.createClient({} as never);
      expect(mocks.createClient).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_CLIENT_HOST_TEST;
      else process.env.AGENT_DECK_CLIENT_HOST_TEST = previous;
    }
  });
});
