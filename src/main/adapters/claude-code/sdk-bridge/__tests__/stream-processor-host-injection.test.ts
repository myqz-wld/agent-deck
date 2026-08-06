import { describe, expect, it, vi } from 'vitest';

import { ClaudeSdkBridge } from '../index';
import type { ClaudeStreamProcessorHost } from '../stream-processor-core';
import {
  makeInternalSession,
  type InternalSession,
  type SdkBridgeOptions,
} from '../types';

describe('Claude bridge stream processor host', () => {
  it('materializes queued attachments through the injected aggregate host', async () => {
    const readAttachmentBase64 = vi.fn(async () => 'injected-base64');
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
        guardSourceIngress: vi.fn(() => false),
        acceptedEnqueueEventFailed: vi.fn(),
        now: vi.fn(() => 123),
      },
      sessionLifecycleHost: {},
      pendingOutgoingHost: {},
      streamProcessorHost: {
        userMessages: {
          readAttachmentBase64,
          createProviderMessageId: vi.fn(() => 'provider-message'),
          now: vi.fn(() => 123),
        },
      } as unknown as ClaudeStreamProcessorHost,
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

    await bridge.sendMessage('session-a', 'caption', [{
      kind: 'uploaded',
      path: '/repo/image.png',
      mime: 'image/png',
      bytes: 12,
    }]);

    expect(internal.pendingUserMessages).toHaveLength(1);
    await expect(internal.pendingUserMessages[0]!()).resolves.toMatchObject({
      type: 'user',
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'injected-base64' },
          },
          { type: 'text', text: 'caption' },
        ],
      },
    });
    expect(readAttachmentBase64).toHaveBeenCalledWith('/repo/image.png');
  });
});
