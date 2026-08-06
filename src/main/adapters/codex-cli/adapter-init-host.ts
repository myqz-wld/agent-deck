import { settingsStore } from '@main/store/settings-store';
import { CodexSdkBridge } from './sdk-bridge';
import type { CodexAdapterInitHost } from './adapter-init-core';
import { formatEventsForPrompt } from '@main/session/summarizer/event-formatter';
import { resolveCodexModelProvider } from '@main/codex-config/model-providers';
import { desktopRecoveryContinuationHost } from '@main/session/continuation-context/recovery-host';
import { desktopCodexBridgeRuntimeHost } from './sdk-bridge/runtime-host';
import { createCodexCliAdapterHost } from './aggregate-host-core';
import { codexDesktopEphemeralFilter } from './desktop-ephemeral-filter';
import { hookRouteDiagnostics } from '@main/hook-server/route-diagnostics-host';
import { openToolUseRepo } from '@main/store/open-tool-use-repo';
import { desktopCodexSummaryRunnerHost } from './summarizer-runner-host';
import log from '@main/utils/logger';

const logger = log.scope('codex-adapter-host');

const desktopCodexBridgeHost: CodexAdapterInitHost<CodexSdkBridge> = {
  recoveryContinuationHost: desktopRecoveryContinuationHost,
  runtimeHost: desktopCodexBridgeRuntimeHost,
  createBridge: (options) => new CodexSdkBridge(options),
  readCodexCliPath: () => settingsStore.get('codexCliPath'),
  readPermissionTimeoutMs: () => settingsStore.get('permissionTimeoutMs'),
};

export const desktopCodexCliAdapterHost = createCodexCliAdapterHost({
  bridge: desktopCodexBridgeHost,
  hookInstallerObserver: {
    statusReadFailed: (error) => {
      logger.warn('[codex-hook-installer] status readHookConfig failed:', error);
    },
  },
  hookRoutes: {
    filter: codexDesktopEphemeralFilter,
    diagnostics: hookRouteDiagnostics,
    openToolUseReader: openToolUseRepo,
    observer: {
      reconciliationFailed: ({ sessionId, terminalHook, error }) => {
        logger.warn('[codex-hook-routes] open tool reconciliation failed', {
          sessionId,
          terminalHook,
        }, error);
      },
    },
  },
  providerResolver: {
    resolveProvider: (provider) => resolveCodexModelProvider(provider)?.id,
  },
  summary: {
    ...desktopCodexSummaryRunnerHost,
    formatEvents: (events) => formatEventsForPrompt(events),
  },
});

export const desktopCodexAdapterInitHost = desktopCodexCliAdapterHost.bridge;
