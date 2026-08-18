import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostNodeConfigurationController } from './service-node-configuration';
import { DEFAULT_SETTINGS } from '@shared/types';

function configuration() {
  return {
    providerDefaults: {
      claudeCliPath: '/opt/claude', claudeCodeSandbox: 'strict' as const,
      codexCliPath: '/opt/codex', codexSandbox: 'read-only' as const,
      continuationCheckpointAdapter: 'claude-code' as const,
      continuationCheckpointAutoRefreshEnabled: true,
      continuationCheckpointAutoRefreshIntervalMinutes: 30,
      continuationCheckpointMaxConcurrent: 2,
      continuationCheckpointModel: '', continuationCheckpointRuntimeProvider: '',
      continuationCheckpointThinking: 'medium' as const,
      continuationRawRetentionTokens: 64_000,
      enableAgentDeckMcp: true, grokCliPath: '/opt/grok', grokSandbox: 'off',
      injectAgentDeckClaudeAgents: true, injectAgentDeckClaudeMd: true,
      injectAgentDeckClaudeSkills: true, injectAgentDeckCodexAgents: true,
      injectAgentDeckCodexAgentsMd: true, injectAgentDeckCodexSkills: true,
      injectAgentDeckGrokAgents: true, injectAgentDeckGrokAgentsMd: true,
      injectAgentDeckGrokSkills: true, mcpHttpEnabled: true,
      mcpMaxFanOutPerParent: 10, mcpMaxSpawnDepth: 3, mcpSpawnRatePerMinute: 20,
      permissionTimeoutMs: 30_000, summaryAdapter: 'claude-code' as const,
      summaryEnabled: true, summaryEventCount: 30, summaryIntervalMs: 300_000,
      summaryMaxConcurrent: 2, summaryModel: 'summary', summaryRuntimeProvider: '',
      summaryThinking: 'low' as const,
    },
    sessionLifecycle: {
      activeWindowMs: DEFAULT_SETTINGS.activeWindowMs,
      closeAfterMs: DEFAULT_SETTINGS.closeAfterMs,
      historyRetentionDays: DEFAULT_SETTINGS.historyRetentionDays,
      issueResolvedRetentionDays: DEFAULT_SETTINGS.issueResolvedRetentionDays,
      issueSoftDeletedRetentionDays: DEFAULT_SETTINGS.issueSoftDeletedRetentionDays,
      messageRetentionDays: DEFAULT_SETTINGS.messageRetentionDays,
    },
    revision: 5,
  };
}

function scoped(clientRequest: ReturnType<typeof vi.fn>) {
  const admitted = vi.fn(async (
    _profileId: string,
    _method: string,
    run: (scope: RemoteHostScopedClient) => Promise<unknown>,
  ) => run({
    client: { request: clientRequest } as unknown as RemoteHostScopedClient['client'],
    profileEpoch: 1,
    profileId: 'remote-a',
    sourceEpoch: 1,
  }));
  return { admitted, request: admitted as never };
}

describe('RemoteHostNodeConfigurationController', () => {
  it('reads the selected Core configuration without a local fallback', async () => {
    const clientRequest = vi.fn(async () => configuration());
    const scope = scoped(clientRequest);
    const controller = new RemoteHostNodeConfigurationController(scope.request);
    await expect(controller.get({ profileId: 'remote-a' })).resolves.toMatchObject({
      revision: 5,
      providerDefaults: { claudeCodeSandbox: 'strict' },
    });
    expect(scope.admitted).toHaveBeenCalledWith(
      'remote-a',
      'node.configuration.get',
      expect.any(Function),
    );
  });

  it('rejects a Hook projection returned for a different adapter', async () => {
    const clientRequest = vi.fn(async () => ({
      adapterId: 'grok-build',
      revision: 6,
      status: {
        supported: false,
        state: 'unavailable',
        scope: null,
        writeAllowed: false,
        disabledReason: 'adapter-unavailable',
      },
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostNodeConfigurationController(scope.request);
    await expect(controller.status({
      profileId: 'remote-a',
      adapterId: 'claude-code',
    })).rejects.toMatchObject({ code: 'protocol_violation' });
  });
});
