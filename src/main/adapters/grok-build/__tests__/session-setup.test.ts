import { describe, expect, it, vi } from 'vitest';

import type { GrokRuntime } from '../runtime-types';
import { buildGrokSessionMeta } from '../session-setup';
import { createGrokTranslationState } from '../translate';

function makeRuntime(overrides: Partial<GrokRuntime> = {}): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: null,
    cwd: '/repo',
    process: null,
    ready: false,
    queue: [],
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: null,
    thinking: null,
    sessionMode: null,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
    ...overrides,
    runtimeIdentity: overrides.runtimeIdentity ?? null,
    grokSandbox: overrides.grokSandbox ?? null,
    activeGrokSandbox: overrides.activeGrokSandbox ?? overrides.grokSandbox ?? null,
    restartingSandbox: overrides.restartingSandbox ?? false,
  };
}

describe('buildGrokSessionMeta', () => {
  it('injects application rules alongside a named agent profile', async () => {
    const getPluginDirectories = vi.fn(async () => ['/plugin']);
    const meta = await buildGrokSessionMeta(
      makeRuntime({
        agentProfileName: 'reviewer-grok',
        agentProfileSource: 'plugin',
        agentPluginDir: '/plugin',
        model: 'grok-4.5',
        thinking: 'xhigh',
      }),
      {
        mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
        isAgentDeckMcpEnabled: () => true,
        getAgentProfilePrompt: async () => '# Agent Deck rules',
        getPluginDirectories,
      },
    );

    expect(meta).toEqual({
      rules: '# Agent Deck rules',
      agentProfile: 'reviewer-grok',
      pluginDirs: ['/plugin'],
      modelId: 'grok-4.5',
      reasoningEffort: 'xhigh',
    });
    expect(getPluginDirectories).toHaveBeenCalledWith({
      requiresAgent: true,
      agentSource: 'plugin',
      agentPluginDir: '/plugin',
    });
  });

  it('omits disabled optional metadata', async () => {
    const getPluginDirectories = vi.fn(async () => []);
    const meta = await buildGrokSessionMeta(makeRuntime(), {
      mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
      isAgentDeckMcpEnabled: () => false,
      getAgentProfilePrompt: async () => null,
      getPluginDirectories,
    });

    expect(meta).toEqual({});
    expect(getPluginDirectories).toHaveBeenCalledWith({
      requiresAgent: false,
      agentSource: null,
      agentPluginDir: null,
    });
  });
});
