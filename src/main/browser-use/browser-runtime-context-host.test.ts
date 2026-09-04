import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: (key: string) => settings.get(key) },
}));

import {
  allowClaudeBrowserSocket,
  browserSkillEnabled,
  codexBrowserSocketConfig,
  refreshBrowserRuntimeSession,
  setBrowserRuntimeContextManagerForTests,
} from './browser-runtime-context-host';

describe('Browser runtime Skills-switch gating', () => {
  beforeEach(() => {
    settings.clear();
    settings.set('injectAgentDeckClaudeSkills', true);
    settings.set('injectAgentDeckCodexSkills', true);
    settings.set('injectAgentDeckGrokSkills', true);
  });

  afterEach(() => setBrowserRuntimeContextManagerForTests(null, null));

  it.each([
    ['claude-code', 'injectAgentDeckClaudeSkills'],
    ['codex-cli', 'injectAgentDeckCodexSkills'],
    ['grok-build', 'injectAgentDeckGrokSkills'],
  ] as const)('uses the existing %s bundled-skills switch', (adapterId, key) => {
    expect(browserSkillEnabled(adapterId)).toBe(true);
    settings.set(key, false);
    expect(browserSkillEnabled(adapterId)).toBe(false);
  });

  it('adds only the exact broker socket to Claude and Codex sandbox configuration', () => {
    setBrowserRuntimeContextManagerForTests(null, '/tmp/agent-deck-browser-cli/exact');
    expect(allowClaudeBrowserSocket({
      sandbox: { enabled: true, network: { allowUnixSockets: ['/tmp/existing'] } },
    })).toEqual({
      sandbox: {
        enabled: true,
        network: {
          allowUnixSockets: ['/tmp/existing', '/tmp/agent-deck-browser-cli/exact'],
        },
      },
    });
    expect(codexBrowserSocketConfig({
      PATH: '/browser-bin:/usr/bin',
      AGENT_DECK_BROWSER_RUNTIME_KEY: 'runtime-key',
      AGENT_DECK_BROWSER_BIN_DIR: '/browser-bin',
    })).toMatchObject({
      shell_environment_policy: { set: { PATH: '/browser-bin:/usr/bin' } },
      features: {
        network_proxy: {
          enabled: true,
          unix_sockets: { '/tmp/agent-deck-browser-cli/exact': 'allow' },
        },
      },
    });
  });

  it('renews an existing session through the host without surfacing repair failures', () => {
    const refreshSession = vi.fn(() => ({ runtimeKey: 'renewed' }));
    setBrowserRuntimeContextManagerForTests({ refreshSession } as never, '/tmp/browser');

    expect(refreshBrowserRuntimeSession('session-a')).toBe(true);
    expect(refreshSession).toHaveBeenCalledWith('session-a');
    refreshSession.mockImplementation(() => { throw new Error('temp storage unavailable'); });
    expect(refreshBrowserRuntimeSession('session-a')).toBe(false);
  });
});
