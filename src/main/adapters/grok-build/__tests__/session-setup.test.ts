import { describe, expect, it } from 'vitest';

import type { GrokRuntime } from '../runtime-types';
import { buildGrokSessionMeta } from '../session-setup';
import { createGrokTranslationState } from '../translate';

function makeRuntime(overrides: Partial<GrokRuntime> = {}): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: null,
    cwd: '/repo',
    process: null,
    queue: [],
    running: false,
    sealed: false,
    closed: false,
    suppressUpdates: false,
    model: null,
    thinking: null,
    sessionMode: null,
    agentProfileName: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
    ...overrides,
  };
}

describe('buildGrokSessionMeta', () => {
  it('injects application rules alongside a named agent profile', async () => {
    const meta = await buildGrokSessionMeta(
      makeRuntime({
        agentProfileName: 'reviewer-grok',
        model: 'grok-4.5',
        thinking: 'xhigh',
      }),
      {
        mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
        isAgentDeckMcpEnabled: () => true,
        getAgentProfilePrompt: async () => '# Agent Deck rules',
        getPluginDirectories: async () => ['/plugin'],
      },
    );

    expect(meta).toEqual({
      rules: '# Agent Deck rules',
      agentProfile: 'reviewer-grok',
      pluginDirs: ['/plugin'],
      modelId: 'grok-4.5',
      reasoningEffort: 'xhigh',
    });
  });

  it('omits disabled optional metadata', async () => {
    const meta = await buildGrokSessionMeta(makeRuntime(), {
      mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
      isAgentDeckMcpEnabled: () => false,
      getAgentProfilePrompt: async () => null,
      getPluginDirectories: async () => [],
    });

    expect(meta).toEqual({});
  });
});
