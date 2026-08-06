import { describe, expect, it, vi } from 'vitest';

const updateCliSessionId = vi.hoisted(() => vi.fn());
const setClaudeCodeSandbox = vi.hoisted(() => vi.fn());
const setRuntimeProvider = vi.hoisted(() => vi.fn());
const setAgentRuntimeProfile = vi.hoisted(() => vi.fn());
const setModel = vi.hoisted(() => vi.fn());
const setThinking = vi.hoisted(() => vi.fn());
const setExtraAllowWrite = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const emit = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    setClaudeCodeSandbox,
    setRuntimeProvider,
    setAgentRuntimeProfile,
    setModel,
    setThinking,
    setExtraAllowWrite,
    get,
  },
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit } }));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => ({ warn }) } }));

describe('desktop Claude session finalize host', () => {
  it('owns session persistence, publication, and diagnostics', async () => {
    const record = { id: 'application' };
    get.mockReturnValue(record);
    const { createDesktopClaudeSessionFinalizeHost } = await import('./session-finalize-host');
    const host = createDesktopClaudeSessionFinalizeHost({ updateCliSessionId });

    host.updateCliSessionId('application', 'native');
    host.setSandbox('application', 'workspace-write');
    host.setRuntimeProvider('application', 'gateway');
    host.setAgentRuntimeProfile('application', {
      agentProfileName: 'agent', agentProfileSource: 'plugin', agentPluginDir: '/plugin',
    });
    host.setModel('application', 'model');
    host.setThinking('application', 'xhigh');
    host.setExtraAllowWrite('application', ['/write']);
    host.publishPersistedSession('application');
    host.warn('warning', new Error('failure'));

    expect(updateCliSessionId).toHaveBeenCalledWith('application', 'native');
    expect(setClaudeCodeSandbox).toHaveBeenCalledWith('application', 'workspace-write');
    expect(setRuntimeProvider).toHaveBeenCalledWith('application', 'gateway');
    expect(setAgentRuntimeProfile).toHaveBeenCalledWith('application', {
      agentProfileName: 'agent', agentProfileSource: 'plugin', agentPluginDir: '/plugin',
    });
    expect(setModel).toHaveBeenCalledWith('application', 'model');
    expect(setThinking).toHaveBeenCalledWith('application', 'xhigh');
    expect(setExtraAllowWrite).toHaveBeenCalledWith('application', ['/write']);
    expect(emit).toHaveBeenCalledWith('session-upserted', record);
    expect(warn).toHaveBeenCalledWith('warning', expect.any(Error));
  });
});
