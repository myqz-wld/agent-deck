import type { SdkBridgeOptions } from './sdk-bridge/types';

export interface ClaudeAdapterInitHost<T> {
  createSessionHost: SdkBridgeOptions['createSessionHost'];
  jsonlDiscoveryHost: SdkBridgeOptions['jsonlDiscoveryHost'];
  recoveryFreshnessHost: SdkBridgeOptions['recoveryFreshnessHost'];
  restartSessionHost: SdkBridgeOptions['restartSessionHost'];
  sessionModelHost: SdkBridgeOptions['sessionModelHost'];
  usageSnapshotHost: SdkBridgeOptions['usageSnapshotHost'];
  permissionResponderHost: SdkBridgeOptions['permissionResponderHost'];
  cwdTransitionHost: SdkBridgeOptions['cwdTransitionHost'];
  messageControllerHost: SdkBridgeOptions['messageControllerHost'];
  sessionLifecycleHost: SdkBridgeOptions['sessionLifecycleHost'];
  pendingOutgoingHost: SdkBridgeOptions['pendingOutgoingHost'];
  streamProcessorHost: SdkBridgeOptions['streamProcessorHost'];
  sessionFinalizeHost: SdkBridgeOptions['sessionFinalizeHost'];
  canUseToolHost: SdkBridgeOptions['canUseToolHost'];
  createSessionSdkQueryHost: SdkBridgeOptions['createSessionSdkQueryHost'];
  sessionManager: SdkBridgeOptions['sessionManager'];
  createBridge(options: SdkBridgeOptions): T;
  readPermissionTimeoutMs(): number;
}

/** Construct the Claude bridge without discovering desktop settings or implementation state. */
export function createClaudeAdapterBridgeWithHost<T>(
  host: ClaudeAdapterInitHost<T>,
  emit: SdkBridgeOptions['emit'],
): T {
  return host.createBridge({
    createSessionHost: host.createSessionHost,
    jsonlDiscoveryHost: host.jsonlDiscoveryHost,
    recoveryFreshnessHost: host.recoveryFreshnessHost,
    restartSessionHost: host.restartSessionHost,
    sessionModelHost: host.sessionModelHost,
    usageSnapshotHost: host.usageSnapshotHost,
    permissionResponderHost: host.permissionResponderHost,
    cwdTransitionHost: host.cwdTransitionHost,
    messageControllerHost: host.messageControllerHost,
    sessionLifecycleHost: host.sessionLifecycleHost,
    pendingOutgoingHost: host.pendingOutgoingHost,
    streamProcessorHost: host.streamProcessorHost,
    sessionFinalizeHost: host.sessionFinalizeHost,
    canUseToolHost: host.canUseToolHost,
    createSessionSdkQueryHost: host.createSessionSdkQueryHost,
    emit,
    sessionManager: host.sessionManager,
    adapterId: 'claude-code',
    permissionTimeoutMs: host.readPermissionTimeoutMs(),
  });
}
