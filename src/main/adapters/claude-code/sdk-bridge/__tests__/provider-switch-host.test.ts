import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  record: {
    id: 'session-a',
    cwd: '/repo',
    activity: 'idle',
    runtimeProvider: null as string | null,
    model: 'old-model' as string | null,
    thinking: 'low' as string | null,
  },
  publish: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sessionId: string) => sessionId === state.record.id ? { ...state.record } : null,
    setRuntimeProvider: (_sessionId: string, value: string | null) => {
      state.record.runtimeProvider = value;
    },
    setModel: (_sessionId: string, value: string | null) => {
      state.record.model = value;
    },
    setThinking: (_sessionId: string, value: string | null) => {
      state.record.thinking = value;
    },
  },
}));
vi.mock('@main/event-bus', () => ({
  eventBus: { emit: state.publish, off: vi.fn(), on: vi.fn(() => vi.fn()) },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { ClaudeSdkBridge } from '../index';
import { makeInternalSession, type InternalSession, type SdkBridgeOptions } from '../types';

describe('Claude live provider switch host', () => {
  beforeEach(() => {
    state.record.runtimeProvider = null;
    state.record.model = 'old-model';
    state.record.thinking = 'low';
    state.publish.mockClear();
  });

  it('validates Gateway selection through the injected create host', async () => {
    const resolveGatewayProfile = vi.fn(() => {
      throw new Error('injected Gateway profile rejection');
    });
    const options = {
      createSessionHost: {
        readPersistedSession: vi.fn(() => null),
        readSandboxDefault: vi.fn(() => 'strict'),
        resolveGatewayProfile,
        deleteTransientSession: vi.fn(),
      },
      jsonlDiscoveryHost: {
        transcriptPath: vi.fn(() => '/tmp/session-a.jsonl'),
        pathExists: vi.fn(() => true),
        pathMtimeMs: vi.fn(() => 123),
      },
      recoveryFreshnessHost: {
        latestConversationMessageTs: vi.fn(() => null),
        warn: vi.fn(),
      },
      restartSessionHost: {
        readSession: vi.fn(() => null),
        setPermissionModeAndPublish: vi.fn(),
        setSandboxAndPublish: vi.fn(),
        subscribeRenames: vi.fn(() => vi.fn()),
        warn: vi.fn(),
      },
      sessionModelHost: {
        read: (sessionId: string) => sessionId === state.record.id ? { ...state.record } : null,
        setRuntimeProvider: (_sessionId: string, value: string | null) => {
          state.record.runtimeProvider = value;
        },
        setModel: (_sessionId: string, value: string | null) => {
          state.record.model = value;
        },
        setThinking: (_sessionId: string, value: string | null) => {
          state.record.thinking = value;
        },
        publishUpdated: state.publish,
        now: () => 123,
        info: vi.fn(),
        warn: vi.fn(),
      },
      usageSnapshotHost: {
        loadSdk: vi.fn(),
        getRuntimeOptions: vi.fn(),
        resolveClaudeBinary: vi.fn(),
        getProbeCwd: vi.fn(),
        expectSdkSession: vi.fn(),
        now: () => 123,
      },
      permissionResponderHost: {},
      cwdTransitionHost: {},
      messageControllerHost: {},
      sessionLifecycleHost: {},
      pendingOutgoingHost: {},
      streamProcessorHost: {},
      sessionFinalizeHost: {},
      canUseToolHost: {},
      createSessionSdkQueryHost: {},
      sessionManager: {},
      emit: vi.fn(),
    } as unknown as SdkBridgeOptions;
    const bridge = new ClaudeSdkBridge(options);
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'session-a' });
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      'session-a',
      internal,
    );

    await expect(bridge.setSessionModelOptions('session-a', {
      gateway: 'missing-profile',
      model: 'new-model',
      thinking: 'high',
    })).rejects.toThrow('injected Gateway profile rejection');

    expect(resolveGatewayProfile).toHaveBeenCalledWith('missing-profile');
    expect(state.record).toMatchObject({
      runtimeProvider: null,
      model: 'old-model',
      thinking: 'low',
    });
    expect(state.publish).toHaveBeenCalledTimes(2);
  });
});
