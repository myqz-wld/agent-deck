import type { AgentCwdTransition } from '@main/adapters/types';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeSdkBridge } from '../index';
import { makeInternalSession, type InternalSession, type SdkBridgeOptions } from '../types';

describe('Claude bridge cwd transition host', () => {
  it('reads the transition record through the injected host', async () => {
    const getSession = vi.fn(() => null);
    const bridge = new ClaudeSdkBridge({
      createSessionHost: {},
      jsonlDiscoveryHost: {},
      recoveryFreshnessHost: {},
      restartSessionHost: { subscribeRenames: () => vi.fn(), warn: vi.fn() },
      sessionModelHost: {},
      usageSnapshotHost: {},
      permissionResponderHost: {},
      cwdTransitionHost: { getSession },
      messageControllerHost: {},
      sessionLifecycleHost: {},
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
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      'session-a',
      internal,
    );
    const transition: AgentCwdTransition = {
      sessionId: 'session-a',
      generation: 5,
      direction: 'enter',
      fromCwd: '/repo',
      targetCwd: '/repo/worktree',
      continuationKey: 'cwd:test:5',
      continuationText: 'continue in the worktree',
    };

    bridge.armCwdTransition(transition);
    await expect(bridge.switchCwdForTransition(transition)).rejects.toThrow(
      'session session-a not found',
    );
    expect(getSession).toHaveBeenCalledWith('session-a');
  });
});
