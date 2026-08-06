import { sessionManager } from '@main/session/manager';
import { settingsStore } from '@main/store/settings-store';
import { ClaudeSdkBridge } from './sdk-bridge';
import type { ClaudeAdapterInitHost } from './adapter-init-core';
import { summariseViaLlm } from '@main/session/summarizer/llm-runners';
import { createClaudeSessionManagerPort } from './session-manager-core';
import { desktopClaudeSessionDefaultsHost } from './sdk-bridge/session-defaults-host';
import { desktopClaudeRestartSessionHost } from './sdk-bridge/restart-session-host';
import { desktopClaudeRecoveryFreshnessHost } from './sdk-bridge/recovery-freshness-host';
import { desktopSessionModelControllerHost } from '../session-model-controller-host';
import { desktopClaudeJsonlDiscoveryHost } from './sdk-bridge/recoverer/jsonl-discovery-host';
import { createDesktopClaudeUsageSnapshotHost } from './usage-snapshot-host';
import { desktopClaudePermissionResponderHost } from './sdk-bridge/permission-responder-host';
import { desktopClaudeCwdTransitionHost } from './sdk-bridge/cwd-transition-controller-host';
import { desktopClaudeMessageControllerHost } from './sdk-bridge/message-controller-host';
import { createDesktopClaudeSessionLifecycleHost } from './sdk-bridge/session-lifecycle-host';
import { desktopClaudePendingOutgoingHost } from './sdk-bridge/pending-outgoing-host';
import { createDesktopClaudeStreamProcessorHost } from './sdk-bridge/stream-processor-host';
import { createDesktopClaudeSessionFinalizeHost } from './sdk-bridge/session-finalize-host';
import { desktopClaudeCanUseToolHost } from './sdk-bridge/can-use-tool-host';
import { desktopClaudeCreateSessionSdkQueryHost } from './sdk-bridge/create-session/create-session-sdk-query-host';
import { desktopClaudeFamilyForkHost } from './fork-session-host';
import { assertClaudeGatewayForkTranscriptRootCompatible } from './gateway-fork-safety';
import { hookRouteDiagnostics } from '@main/hook-server/route-diagnostics-host';
import { desktopClaudeHookInstallerObserver } from './hook-installer-host';
import { createClaudeCodeAdapterHost } from './aggregate-host-core';

const desktopClaudeSessionManager = createClaudeSessionManagerPort(sessionManager);

const desktopClaudeBridgeHost: ClaudeAdapterInitHost<ClaudeSdkBridge> = {
  createSessionHost: desktopClaudeSessionDefaultsHost,
  jsonlDiscoveryHost: desktopClaudeJsonlDiscoveryHost,
  recoveryFreshnessHost: desktopClaudeRecoveryFreshnessHost,
  restartSessionHost: desktopClaudeRestartSessionHost,
  sessionModelHost: desktopSessionModelControllerHost,
  usageSnapshotHost: createDesktopClaudeUsageSnapshotHost(desktopClaudeSessionManager),
  permissionResponderHost: desktopClaudePermissionResponderHost,
  cwdTransitionHost: desktopClaudeCwdTransitionHost,
  messageControllerHost: desktopClaudeMessageControllerHost,
  sessionLifecycleHost: createDesktopClaudeSessionLifecycleHost(desktopClaudeSessionManager),
  pendingOutgoingHost: desktopClaudePendingOutgoingHost,
  streamProcessorHost: createDesktopClaudeStreamProcessorHost(desktopClaudeSessionManager),
  sessionFinalizeHost: createDesktopClaudeSessionFinalizeHost(desktopClaudeSessionManager),
  canUseToolHost: desktopClaudeCanUseToolHost,
  createSessionSdkQueryHost: desktopClaudeCreateSessionSdkQueryHost,
  sessionManager: desktopClaudeSessionManager,
  createBridge: (options) => new ClaudeSdkBridge(options),
  readPermissionTimeoutMs: () => settingsStore.get('permissionTimeoutMs'),
};

export const desktopClaudeCodeAdapterHost = createClaudeCodeAdapterHost({
  bridge: desktopClaudeBridgeHost,
  fork: desktopClaudeFamilyForkHost,
  hookDiagnostics: hookRouteDiagnostics,
  hookInstallerObserver: desktopClaudeHookInstallerObserver,
  forkSafety: {
    validateForkTarget: (gateway) =>
      assertClaudeGatewayForkTranscriptRootCompatible(gateway),
  },
  summary: {
    summariseEvents: (cwd, events, evidenceContext, runtime) => summariseViaLlm(
      cwd,
      events,
      {
        ...(evidenceContext ? { evidenceContext } : {}),
        runtimeProvider: runtime?.provider,
        model: runtime?.model,
        thinking: runtime?.thinking,
      },
    ),
  },
});

export const desktopClaudeAdapterInitHost = desktopClaudeCodeAdapterHost.bridge;
