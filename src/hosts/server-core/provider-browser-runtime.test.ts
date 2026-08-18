import { describe, expect, it, vi } from 'vitest';

import type { ServerCoreProviderHostInput } from './provider-host-common';
import { createServerCoreClaudeQueryHost } from './provider-claude-query-host';
import { createServerCoreCodexClientConstructionHost } from './provider-codex-host';
import { createServerCoreGrokHost } from './provider-grok-host';

function input() {
  const prepared = {
    environment: { PATH: '/private/browser/bin:/usr/bin' },
  };
  const browserRuntime = {
    prepare: vi.fn(() => prepared),
    revokeSession: vi.fn(() => 1),
    allowClaudeSocket: vi.fn((value) => ({ ...value, browserAllowed: true })),
    codexSocketConfig: vi.fn(() => ({ features: { network_proxy: { enabled: true } } })),
    refresh: vi.fn(),
    renameSession: vi.fn(),
  };
  const value = {
    browserRuntime,
    diagnostics: { info: vi.fn(), warn: vi.fn() },
    settings: {
      claudeCliPath: '/opt/claude',
      codexCliPath: '/opt/codex',
      grokCliPath: '/opt/grok',
      codexSandbox: 'workspace-write',
      enableAgentDeckMcp: true,
      injectAgentDeckClaudeMd: true,
      injectAgentDeckCodexAgentsMd: true,
      injectAgentDeckGrokAgents: true,
      injectAgentDeckGrokAgentsMd: true,
      injectAgentDeckGrokSkills: true,
      mcpHttpEnabled: false,
      permissionTimeoutMs: 30_000,
      summaryModel: null,
      summaryThinking: null,
    },
    workspaceBoundary: {
      workspaceRoot: '/workspaces',
      privateRoot: '/private',
      providerHomeRoot: '/private/home',
      runtimeReadRoots: ['/opt/agent-deck'],
      providerCacheRoot: '/private/cache',
      providerTempRoot: '/private/tmp',
    },
    assets: {
      codexSkillExtraRoots: () => [],
      grokBaselinePrompt: async () => null,
      grokPluginProfile: async () => null,
    },
    repositories: {
      sessions: { get: vi.fn() },
      sessionManager: {},
    },
    worktrees: { hasPendingTransition: vi.fn(() => false) },
    mcpBroker: { isRunning: true },
  } as unknown as ServerCoreProviderHostInput;
  return { browserRuntime, prepared, value };
}

describe('Server Core provider Browser runtime injection', () => {
  it('uses the same ambient context and exact socket seams for Claude and Codex', () => {
    const state = input();
    const claude = createServerCoreClaudeQueryHost(state.value);
    const codex = createServerCoreCodexClientConstructionHost(state.value);

    expect(claude.prepareBrowserRuntime?.('session-a', { PATH: '/usr/bin' }))
      .toBe(state.prepared);
    expect(state.browserRuntime.prepare).toHaveBeenCalledWith({
      applicationSessionId: 'session-a', adapterId: 'claude-code',
      environment: { PATH: '/usr/bin' },
    });
    expect(claude.allowBrowserSocket?.({ sandbox: {} })).toMatchObject({
      browserAllowed: true,
    });

    expect(codex.prepareBrowserRuntime?.('session-b', { PATH: '/usr/bin' }))
      .toBe(state.prepared);
    expect(state.browserRuntime.prepare).toHaveBeenLastCalledWith({
      applicationSessionId: 'session-b', adapterId: 'codex-cli',
      environment: { PATH: '/usr/bin' },
    });
    expect(codex.browserSocketConfig?.(state.prepared.environment)).toMatchObject({
      features: { network_proxy: { enabled: true } },
    });
  });

  it('prepares and revokes the Grok CLI context through the shared runtime host', () => {
    const state = input();
    const host = createServerCoreGrokHost(state.value);
    const runtimeHost = host.bridge.bridgeRuntimeHost;

    expect(runtimeHost.prepareBrowserRuntimeEnvironment?.('session-c')).toEqual(
      state.prepared.environment,
    );
    expect(state.browserRuntime.prepare).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: 'session-c', adapterId: 'grok-build',
    }));
    runtimeHost.revokeBrowserRuntime?.('session-c');
    expect(state.browserRuntime.revokeSession).toHaveBeenCalledWith('session-c');
  });
});
