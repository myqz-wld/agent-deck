import { describe, expect, it, vi } from 'vitest';

import { buildAgentDeckMcpConfigForCodex } from '@main/codex-config/agent-deck-mcp-injector';

import {
  mergeServerCoreLocalWorkerDesktopState,
  type ServerCoreLocalWorkerDesktopState,
} from './local-worker-desktop-state';
import { createServerCoreClaudeQueryHost } from './provider-claude-query-host';
import { createServerCoreGrokHost } from './provider-grok-host';
import type { ServerCoreProviderHostInput } from './provider-host-common';
import {
  resolveServerCoreProviderSettings,
  type ServerCoreProviderSettings,
} from './provider-settings';

function disabledFullSettings(): ServerCoreProviderSettings {
  return resolveServerCoreProviderSettings({
    providerSettings: { enableAgentDeckMcp: false, mcpHttpEnabled: false },
  });
}

function disabledRelaySettings(): ServerCoreProviderSettings {
  const state: ServerCoreLocalWorkerDesktopState = {
    providerSettings: resolveServerCoreProviderSettings({
      providerSettings: { enableAgentDeckMcp: false, mcpHttpEnabled: false },
    }),
    sessionLifecycle: {
      activeWindowMs: 60_000,
      closeAfterMs: 120_000,
      historyRetentionDays: 30,
      issueResolvedRetentionDays: 30,
      issueSoftDeletedRetentionDays: 7,
      messageRetentionDays: 30,
    },
  };
  return resolveServerCoreProviderSettings(
    mergeServerCoreLocalWorkerDesktopState({}, state),
  );
}

function providerInput(settings: ServerCoreProviderSettings) {
  const createInProcessServer = vi.fn(async () => ({ type: 'sdk' }));
  return {
    input: {
      settings,
      mcpBroker: {
        isRunning: true,
        listeningPort: 12_345,
        bearerToken: 'hook-token',
        mcpBearerToken: 'mcp-token',
        createInProcessServer,
      },
      diagnostics: { info: vi.fn(), warn: vi.fn() },
      paths: { stateDirectory: '/private/state' },
      repositories: {},
    } as unknown as ServerCoreProviderHostInput,
    createInProcessServer,
  };
}

describe.each([
  ['Relay desktop projection', disabledRelaySettings],
  ['Full deployment configuration', disabledFullSettings],
])('Server Core MCP settings from %s', (_mode, settingsFactory) => {
  it('keeps Claude, Codex, and Grok collaboration disabled when both switches are off', async () => {
    const settings = settingsFactory();
    const { input, createInProcessServer } = providerInput(settings);

    const claude = createServerCoreClaudeQueryHost(input);
    await expect(claude.buildMcpServers(
      { applicationSid: 'session-a' } as never,
      'claude-code',
    )).resolves.toEqual({ agentDeckMcpServer: null });
    expect(createInProcessServer).not.toHaveBeenCalled();

    expect(buildAgentDeckMcpConfigForCodex(settings, input.mcpBroker)).toBeNull();

    const grok = createServerCoreGrokHost(input);
    expect(grok.bridge.readMcpEnabled()).toBe(false);
    expect(grok.bridge.readMcpHttpEnabled()).toBe(false);
  });
});
