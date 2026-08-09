import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn((key: string) => key !== 'injectAgentDeckClaudeAgents'),
  resourcesRoot: vi.fn(() => '/app/resources'),
  substitute: vi.fn((content: string) => `substituted:${content}`),
  userDataPath: '/app/user-data',
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('@main/runtime-host/application-resources', () => ({
  getApplicationResourcesRoot: mocks.resourcesRoot,
}));
vi.mock('@main/runtime-host/application-paths', () => ({
  getApplicationHostPaths: () => ({ userDataPath: mocks.userDataPath }),
}));
vi.mock('@main/utils/resources-placeholder', () => ({
  substituteResourcesPlaceholder: mocks.substitute,
}));

describe('desktop Claude SDK injection host', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owns settings, application paths, and markdown substitution', async () => {
    const { desktopClaudeSdkInjectionHost: host } = await import('./sdk-injection-host');

    expect(host.builtinClaudeMdPath()).toBe('/app/resources/claude-config/CLAUDE.md');
    expect(host.userClaudeMdPath()).toBe('/app/user-data/agent-deck-claude.md');
    expect(host.pluginSourceDir()).toBe(
      '/app/resources/claude-config/agent-deck-plugin',
    );
    expect(host.pluginMirrorDir()).toBe('/app/user-data/agent-deck-plugin');
    expect(host.readInjectSkills()).toBe(true);
    expect(host.readInjectAgents()).toBe(false);
    expect(host.readInjectClaudeMd()).toBe(true);
    expect(host.substituteMarkdown('body')).toBe('substituted:body');
  });
});
