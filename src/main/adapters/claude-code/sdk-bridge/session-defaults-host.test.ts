import { describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());
const deleteSession = vi.hoisted(() => vi.fn());
const getSetting = vi.hoisted(() => vi.fn());
const resolveProfile = vi.hoisted(() => vi.fn());
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: getSession, delete: deleteSession },
}));
vi.mock('@main/store/settings-store', () => ({ settingsStore: { get: getSetting } }));
vi.mock('../gateway-profiles', () => ({ resolveClaudeGatewayProfile: resolveProfile }));

describe('desktop Claude session defaults host', () => {
  it('owns persisted session, global default, and profile reads', async () => {
    const record = { model: 'stored' };
    const profile = {
      id: 'deepseek', settingsPath: '/profile.json', modelAliases: {},
    };
    getSession.mockReturnValue(record);
    getSetting.mockReturnValue('strict');
    resolveProfile.mockReturnValue(profile);
    const { desktopClaudeSessionDefaultsHost: host } = await import('./session-defaults-host');

    expect(host.readPersistedSession('session')).toBe(record);
    expect(host.readSandboxDefault()).toBe('strict');
    expect(host.resolveGatewayProfile('deepseek')).toBe(profile);
    host.deleteTransientSession('temporary-session');
    expect(deleteSession).toHaveBeenCalledWith('temporary-session');
  });
});
