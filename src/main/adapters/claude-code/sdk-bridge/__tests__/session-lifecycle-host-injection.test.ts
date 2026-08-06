import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeSdkBridge } from '../index';
import { makeInternalSession, type InternalSession, type SdkBridgeOptions } from '../types';

describe('Claude bridge session lifecycle host', () => {
  it('runs close cleanup through the injected host', async () => {
    const cleanupSession = vi.fn((input: { sessions: Map<string, InternalSession>; key: string }) => {
      input.sessions.delete(input.key);
    });
    const bridge = new ClaudeSdkBridge({
      createSessionHost: {},
      jsonlDiscoveryHost: {},
      recoveryFreshnessHost: {},
      restartSessionHost: { subscribeRenames: () => vi.fn(), warn: vi.fn() },
      sessionModelHost: {},
      usageSnapshotHost: {},
      permissionResponderHost: {},
      cwdTransitionHost: {},
      messageControllerHost: {},
      sessionLifecycleHost: {
        cleanupSession,
        hasPersistedSession: vi.fn(() => false),
        warn: vi.fn(),
        info: vi.fn(),
      },
      pendingOutgoingHost: {},
      streamProcessorHost: {},
      sessionFinalizeHost: {},
      canUseToolHost: {},
      createSessionSdkQueryHost: {},
      sessionManager: {},
      emit: vi.fn(),
    } as unknown as SdkBridgeOptions);
    const internal = makeInternalSession({
      cwd: '/repo',
      applicationSid: 'session-a',
    });
    const interrupt = vi.fn(async () => undefined);
    internal.query = { interrupt } as unknown as Query;
    internal.resolveStreamDrained();
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      'session-a',
      internal,
    );

    await bridge.closeSession('session-a', { markRecentlyDeleted: true });

    expect(interrupt).toHaveBeenCalledOnce();
    expect(cleanupSession).toHaveBeenCalledWith(expect.objectContaining({
      internal,
      key: 'session-a',
      sessionId: 'session-a',
      markRecentlyDeleted: true,
    }));
  });
});
