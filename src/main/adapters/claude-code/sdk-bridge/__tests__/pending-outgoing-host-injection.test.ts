import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeSdkBridge } from '../index';
import {
  makeInternalSession,
  type InternalSession,
  type PendingUserMessage,
  type SdkBridgeOptions,
} from '../types';

describe('Claude bridge pending outgoing host', () => {
  it('records a successful provider cancellation through the injected host', async () => {
    const rememberIgnoredUserMessageId = vi.fn();
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
      sessionLifecycleHost: {},
      pendingOutgoingHost: { rememberIgnoredUserMessageId },
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
    const pending = vi.fn(async () => ({})) as unknown as PendingUserMessage;
    pending.deferredUserEvent = {
      text: 'queued turn',
      turnCorrelationId: 'turn-a',
    };
    const cancelAsyncMessage = vi.fn(async () => true);
    internal.query = { cancelAsyncMessage } as unknown as Query;
    internal.submittingUserMessage = {
      pending,
      providerMessageId: 'provider-a',
      status: 'submitting',
    };
    internal.userTurnInFlight = true;
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      'session-a',
      internal,
    );

    await expect(bridge.removePendingOutgoingMessage('session-a', 'turn-a'))
      .resolves.toEqual({ id: 'turn-a', text: 'queued turn' });
    expect(cancelAsyncMessage).toHaveBeenCalledWith('provider-a');
    expect(rememberIgnoredUserMessageId).toHaveBeenCalledWith(internal, 'provider-a');
  });
});
