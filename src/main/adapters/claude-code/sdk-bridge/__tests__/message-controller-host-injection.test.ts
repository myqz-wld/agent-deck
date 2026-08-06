import { describe, expect, it, vi } from 'vitest';

import { ClaudeSdkBridge } from '../index';
import type { SdkBridgeOptions } from '../types';

describe('Claude bridge message controller host', () => {
  it('routes ordinary and queued ingress through the injected guard', async () => {
    const guardSourceIngress = vi.fn(() => true);
    const emit = vi.fn();
    const bridge = new ClaudeSdkBridge({
      createSessionHost: {},
      jsonlDiscoveryHost: {},
      recoveryFreshnessHost: {},
      restartSessionHost: { subscribeRenames: () => vi.fn(), warn: vi.fn() },
      sessionModelHost: {},
      usageSnapshotHost: {},
      permissionResponderHost: {},
      cwdTransitionHost: {},
      messageControllerHost: {
        guardSourceIngress,
        acceptedEnqueueEventFailed: vi.fn(),
        now: vi.fn(() => 123),
      },
      sessionLifecycleHost: {},
      pendingOutgoingHost: {},
      streamProcessorHost: {},
      sessionFinalizeHost: {},
      canUseToolHost: {},
      createSessionSdkQueryHost: {},
      sessionManager: {},
      emit,
    } as unknown as SdkBridgeOptions);

    await bridge.sendMessage('session-a', 'ordinary', undefined, {
      bypassWorktreeTransitionGuard: true,
    });
    await bridge.enqueueMessage('session-b', 'queued');

    expect(guardSourceIngress).toHaveBeenCalledTimes(2);
    expect(guardSourceIngress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceSessionId: 'session-a',
      agentId: 'claude-code',
      text: 'ordinary',
      emit,
      bypassWorktreeTransition: true,
      replay: expect.any(Function),
    }));
    expect(guardSourceIngress).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceSessionId: 'session-b',
      agentId: 'claude-code',
      text: 'queued',
      emit,
      bypassWorktreeTransition: false,
      replay: expect.any(Function),
    }));
  });
});
