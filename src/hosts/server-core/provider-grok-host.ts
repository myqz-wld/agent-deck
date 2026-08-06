import { createGrokBuildAdapterHost } from '@main/adapters/grok-build/aggregate-host-core';
import { NOOP_GROK_BRIDGE_DIAGNOSTICS } from '@main/adapters/grok-build/bridge-diagnostics-core';
import { NOOP_GROK_LIVE_RATE_OBSERVER } from '@main/adapters/grok-build/live-token-rate-core';
import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import {
  providerLogger,
  publishProviderSession,
  type ServerCoreProviderHostInput,
} from './provider-host-common';
import { SERVER_CORE_GROK_SANDBOX } from './provider-grok-sandbox';

export const HEADLESS_GROK_EXECUTABLE = '/opt/agent-deck/providers/grok/grok';

/** Concrete Grok value host for one Electron-free Server Core process. */
export function createServerCoreGrokHost(input: ServerCoreProviderHostInput) {
  const logger = providerLogger(input.diagnostics, 'grok-build');
  return createGrokBuildAdapterHost({
    runtimeHost: {
      diagnostics: NOOP_GROK_BRIDGE_DIAGNOSTICS,
      liveRate: NOOP_GROK_LIVE_RATE_OBSERVER,
      records: {
        get: (sessionId) => input.repositories.sessions.get(sessionId),
        setAgentRuntimeProfile: (sessionId, profile) =>
          input.repositories.sessions.setAgentRuntimeProfile(sessionId, profile),
        setRuntimeProvider: (sessionId, provider) =>
          input.repositories.sessions.setRuntimeProvider(sessionId, provider),
        setModel: (sessionId, model) =>
          input.repositories.sessions.setModel(sessionId, model),
        setThinking: (sessionId, thinking) =>
          input.repositories.sessions.setThinking(sessionId, thinking),
        setSessionMode: (sessionId, mode) =>
          input.repositories.sessions.setSessionMode(sessionId, mode),
        setGrokSandbox: (sessionId, sandbox) =>
          input.repositories.sessions.setGrokSandbox(sessionId, sandbox),
        setGrokUsageWatermark: (sessionId, watermark) =>
          input.repositories.sessions.setGrokUsageWatermark(sessionId, watermark),
      },
      transaction: (operation) => input.repositories.transaction(operation),
      publishSessionUpdated: (sessionId) => publishProviderSession(input, sessionId),
      guardHandOffSourceIngress: () => false,
      hasPendingWorktreeTransition: () => false,
    },
    sessionManager: input.repositories.sessionManager,
    settings: {
      readBinaryPath: () => input.settings.grokCliPath ?? HEADLESS_GROK_EXECUTABLE,
      readDefaultSandbox: () => SERVER_CORE_GROK_SANDBOX,
      readInjectAgents: () => false,
      readInjectAgentPrompt: () => false,
      readInjectSkills: () => false,
      readMcpEnabled: () => false,
      readMcpHttpEnabled: () => false,
      readPermissionTimeoutMs: () => input.settings.permissionTimeoutMs,
      readSummaryModel: () => input.settings.summaryModel,
      readSummaryReasoning: () => input.settings.summaryThinking,
      readSummaryTimeoutMs: () => input.settings.summaryTimeoutMs,
    },
    resources: {
      loadBaselinePrompt: async () => null,
      preparePluginProfile: async () => null,
    },
    hookDiagnostics: new HookRouteDiagnostics(),
    hookInstallerObserver: { statusReadFailed: () => undefined },
    diagnostics: {
      reportStartupCleanupFailure: (_sessionId, error) =>
        logger.warn('strict-startup cleanup failed', error),
      reportCapabilityProbeSkipped: (error) =>
        logger.info('capability probe skipped', error),
    },
  });
}
