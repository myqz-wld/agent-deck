import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeAdapterBridgeWithHost,
  type ClaudeAdapterInitHost,
} from './adapter-init-core';

describe('Claude adapter init Core', () => {
  it('binds the exact adapter identity and host-owned timeout', () => {
    const bridge = { name: 'bridge' };
    const sessionManager = {
      claimAsSdk: vi.fn(), releaseSdkClaim: vi.fn(), markRecentlyDeleted: vi.fn(),
      expectSdkSession: vi.fn(), delete: vi.fn(),
      getCloseEpoch: vi.fn(), markClosed: vi.fn(), unarchive: vi.fn(),
      renameSdkSession: vi.fn(), updateCliSessionId: vi.fn(),
    };
    const createSessionHost = {
      readPersistedSession: vi.fn(() => null),
      readSandboxDefault: vi.fn(() => 'off' as const),
      resolveGatewayProfile: vi.fn(() => null),
      deleteTransientSession: vi.fn(),
    };
    const jsonlDiscoveryHost = {} as ClaudeAdapterInitHost<typeof bridge>['jsonlDiscoveryHost'];
    const restartSessionHost = {
      readSession: vi.fn(() => null),
      setPermissionModeAndPublish: vi.fn(),
      setSandboxAndPublish: vi.fn(),
      subscribeRenames: vi.fn(() => vi.fn()),
      warn: vi.fn(),
    };
    const recoveryFreshnessHost = {
      latestConversationMessageTs: vi.fn(() => null),
      warn: vi.fn(),
      captureContinuation: vi.fn(() => ({} as never)),
      prepareContinuation: vi.fn(async () => ({} as never)),
      cleanupContinuation: vi.fn(),
    };
    const sessionModelHost = {} as ClaudeAdapterInitHost<typeof bridge>['sessionModelHost'];
    const usageSnapshotHost = {} as ClaudeAdapterInitHost<typeof bridge>['usageSnapshotHost'];
    const permissionResponderHost = {} as ClaudeAdapterInitHost<typeof bridge>['permissionResponderHost'];
    const cwdTransitionHost = {} as ClaudeAdapterInitHost<typeof bridge>['cwdTransitionHost'];
    const messageControllerHost = {} as ClaudeAdapterInitHost<typeof bridge>['messageControllerHost'];
    const sessionLifecycleHost = {} as ClaudeAdapterInitHost<typeof bridge>['sessionLifecycleHost'];
    const pendingOutgoingHost = {} as ClaudeAdapterInitHost<typeof bridge>['pendingOutgoingHost'];
    const streamProcessorHost = {} as ClaudeAdapterInitHost<typeof bridge>['streamProcessorHost'];
    const sessionFinalizeHost = {} as ClaudeAdapterInitHost<typeof bridge>['sessionFinalizeHost'];
    const canUseToolHost = {} as ClaudeAdapterInitHost<typeof bridge>['canUseToolHost'];
    const createSessionSdkQueryHost = {} as ClaudeAdapterInitHost<typeof bridge>['createSessionSdkQueryHost'];
    const host: ClaudeAdapterInitHost<typeof bridge> = {
      createSessionHost,
      jsonlDiscoveryHost,
      recoveryFreshnessHost,
      restartSessionHost,
      sessionModelHost,
      usageSnapshotHost,
      permissionResponderHost,
      cwdTransitionHost,
      messageControllerHost,
      sessionLifecycleHost,
      pendingOutgoingHost,
      streamProcessorHost,
      sessionFinalizeHost,
      canUseToolHost,
      createSessionSdkQueryHost,
      sessionManager,
      createBridge: vi.fn(() => bridge),
      readPermissionTimeoutMs: vi.fn(() => 12_000),
    };
    const emit = vi.fn();

    expect(createClaudeAdapterBridgeWithHost(host, emit)).toBe(bridge);
    expect(host.readPermissionTimeoutMs).toHaveBeenCalledOnce();
    expect(host.createBridge).toHaveBeenCalledWith({
      adapterId: 'claude-code',
      createSessionHost,
      jsonlDiscoveryHost,
      recoveryFreshnessHost,
      restartSessionHost,
      sessionModelHost,
      usageSnapshotHost,
      permissionResponderHost,
      cwdTransitionHost,
      messageControllerHost,
      sessionLifecycleHost,
      pendingOutgoingHost,
      streamProcessorHost,
      sessionFinalizeHost,
      canUseToolHost,
      createSessionSdkQueryHost,
      emit,
      sessionManager,
      permissionTimeoutMs: 12_000,
    });
  });
});
