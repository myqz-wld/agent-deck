import { createGrokBuildAdapterHost } from '@main/adapters/grok-build/aggregate-host-core';
import { NOOP_GROK_BRIDGE_DIAGNOSTICS } from '@main/adapters/grok-build/bridge-diagnostics-core';
import { NOOP_GROK_LIVE_RATE_OBSERVER } from '@main/adapters/grok-build/live-token-rate-core';
import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import {
  providerLogger,
  publishProviderSession,
  type ServerCoreProviderHostInput,
} from './provider-host-common';

export const HEADLESS_GROK_EXECUTABLE = '/opt/agent-deck/providers/grok/grok';

/** Concrete Grok value host for one Electron-free Server Core process. */
export function createServerCoreGrokHost(input: ServerCoreProviderHostInput) {
  const logger = providerLogger(input.diagnostics, 'grok-build');
  return createGrokBuildAdapterHost({
    processFactory: input.grokProcessFactory,
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
      guardHandOffSourceIngress: (args) => input.worktrees.guardIngress({
        sourceSessionId: args.sourceSessionId,
        agentId: 'grok-build',
        text: args.text,
        attachments: args.attachments,
        emit: args.emit,
        bypassWorktreeTransition: args.bypassWorktreeTransition,
      }),
      hasPendingWorktreeTransition: (sessionId) =>
        input.worktrees.hasPendingTransition(sessionId),
    },
    sessionManager: input.repositories.sessionManager,
    settings: {
      readBinaryPath: () => input.settings.grokCliPath ?? HEADLESS_GROK_EXECUTABLE,
      readDefaultSandbox: () => input.grokProcessFactory ? 'workspace' : 'strict',
      readInjectAgents: () => input.settings.injectAgentDeckGrokAgents,
      readInjectAgentPrompt: () => input.settings.injectAgentDeckGrokAgentsMd,
      readInjectSkills: () => input.settings.injectAgentDeckGrokSkills,
      readMcpEnabled: () =>
        input.settings.enableAgentDeckMcp && input.mcpBroker.isRunning,
      readMcpHttpEnabled: () =>
        input.settings.mcpHttpEnabled && input.mcpBroker.isRunning,
      readPermissionTimeoutMs: () => input.settings.permissionTimeoutMs,
      readSummaryModel: () => input.settings.summaryModel,
      readSummaryReasoning: () => input.settings.summaryThinking,
      readSummaryTimeoutMs: () => input.settings.summaryTimeoutMs,
    },
    resources: {
      loadBaselinePrompt: () => input.assets.grokBaselinePrompt(),
      preparePluginProfile: (options) => input.assets.grokPluginProfile(options),
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
