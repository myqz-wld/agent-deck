import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(function Bridge(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
  getSetting: vi.fn(() => 12_000),
  deleteSession: vi.fn(async () => undefined),
  deleteTransientSession: vi.fn(),
  getSession: vi.fn(() => null),
  latestConversationMessageTs: vi.fn(() => 123),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    delete: mocks.deleteSession,
  },
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    delete: mocks.deleteTransientSession,
    get: mocks.getSession,
  },
}));
vi.mock('@main/store/event-repo', () => ({
  eventRepo: { latestConversationMessageTs: mocks.latestConversationMessageTs },
}));
vi.mock('./sdk-bridge', () => ({
  ClaudeSdkBridge: mocks.bridge,
}));

describe('desktop Claude adapter init host', () => {
  it('owns the permission setting and concrete bridge constructor', async () => {
    const { desktopClaudeCodeAdapterHost } = await import('./adapter-init-host');
    const host = desktopClaudeCodeAdapterHost.bridge;

    expect(host.readPermissionTimeoutMs()).toBe(12_000);
    const options = {
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
      emit: vi.fn(),
      sessionManager: host.sessionManager,
    };
    expect(host.createBridge(options)).toMatchObject({ options });
    await expect(host.sessionManager.delete('session-a')).resolves.toBeUndefined();
    expect(mocks.getSetting).toHaveBeenCalledWith('permissionTimeoutMs');
    expect(mocks.deleteSession).toHaveBeenCalledWith('session-a');
    expect(host.createSessionHost.readPersistedSession('session-a')).toBeNull();
    expect(host.jsonlDiscoveryHost.pathExists('/definitely-not-agent-deck-jsonl')).toBe(false);
    expect(host.restartSessionHost.readSession('session-a')).toBeNull();
    expect(host.recoveryFreshnessHost.latestConversationMessageTs('session-a')).toBe(123);
    expect(host.sessionModelHost.read('session-a')).toBeNull();
    expect(host.usageSnapshotHost.now()).toEqual(expect.any(Number));
    expect(host.permissionResponderHost.now()).toEqual(expect.any(Number));
    expect(host.cwdTransitionHost.getSession('session-a')).toBeNull();
    expect(host.messageControllerHost.now()).toEqual(expect.any(Number));
    expect(host.sessionLifecycleHost.hasPersistedSession('session-a')).toBe(false);
    expect(host.pendingOutgoingHost.rememberIgnoredUserMessageId).toEqual(expect.any(Function));
    expect(host.streamProcessorHost.userMessages.createProviderMessageId).toEqual(expect.any(Function));
    expect(host.sessionFinalizeHost.now()).toEqual(expect.any(Number));
    expect(host.canUseToolHost.createRequestId()).toEqual(expect.any(String));
    expect(host.createSessionSdkQueryHost.runtimeOptions()).toMatchObject({
      executable: expect.any(String),
    });
    host.createSessionHost.deleteTransientSession('temporary-a');
    expect(mocks.getSession).toHaveBeenCalledWith('session-a');
    expect(mocks.deleteTransientSession).toHaveBeenCalledWith('temporary-a');
    expect(mocks.bridge).toHaveBeenCalledWith(options);
  });
});
