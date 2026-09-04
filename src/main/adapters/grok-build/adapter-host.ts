import { settingsStore } from '@main/store/settings-store';
import { sessionManager } from '@main/session/manager';
import log from '@main/utils/logger';
import { hookRouteDiagnostics } from '@main/hook-server/route-diagnostics-host';
import {
  loadGrokBaselinePrompt,
  prepareGrokPluginProfile,
} from './resources';
import { createGrokBuildAdapterHost } from './aggregate-host-core';
import { desktopGrokBridgeRuntimeHost } from './bridge-runtime-host';
import { desktopGrokHookInstallerObserver } from './hook-installer-host';

const logger = log.scope('grok-build-bridge');

export const desktopGrokBuildAdapterHost = createGrokBuildAdapterHost({
  runtimeHost: desktopGrokBridgeRuntimeHost,
  sessionManager,
  resources: {
    loadBaselinePrompt: () => loadGrokBaselinePrompt(),
    preparePluginProfile: (options) => prepareGrokPluginProfile(options),
  },
  settings: {
    readBinaryPath: () => settingsStore.get('grokCliPath'),
    readDefaultSandbox: () => settingsStore.get('grokSandbox'),
    readInjectAgents: () => settingsStore.get('injectAgentDeckGrokAgents'),
    readInjectAgentPrompt: () => settingsStore.get('injectAgentDeckGrokAgentsMd'),
    readInjectSkills: () => settingsStore.get('injectAgentDeckGrokSkills'),
    readMcpEnabled: () => settingsStore.get('enableAgentDeckMcp') === true,
    readMcpHttpEnabled: () => settingsStore.get('mcpHttpEnabled') === true,
    readPermissionTimeoutMs: () => settingsStore.get('permissionTimeoutMs'),
    readSummaryModel: () => settingsStore.get('summaryModel'),
    readSummaryReasoning: () => settingsStore.get('summaryThinking'),
  },
  hookDiagnostics: hookRouteDiagnostics,
  hookInstallerObserver: desktopGrokHookInstallerObserver,
  diagnostics: {
    reportStartupCleanupFailure: (sessionId, error) => {
      logger.warn(
        `[grok-build] failed to remove strict-startup session ${sessionId}`,
        error,
      );
    },
    reportCapabilityProbeSkipped: (error) => {
      logger.info(
        `Grok ACP capability probe skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  },
});
