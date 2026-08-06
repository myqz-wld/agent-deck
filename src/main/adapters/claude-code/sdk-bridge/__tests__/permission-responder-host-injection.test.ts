import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeSdkBridge } from '../index';
import { makeInternalSession, type InternalSession, type SdkBridgeOptions } from '../types';

describe('Claude bridge permission responder host', () => {
  it('persists an approved hot switch through the injected host', async () => {
    const persistPermissionMode = vi.fn();
    const querySetPermissionMode = vi.fn(async () => undefined);
    const resolver = vi.fn();
    const bridge = new ClaudeSdkBridge({
      createSessionHost: {},
      jsonlDiscoveryHost: {},
      recoveryFreshnessHost: {},
      restartSessionHost: { subscribeRenames: () => vi.fn(), warn: vi.fn() },
      sessionModelHost: {},
      usageSnapshotHost: {},
      permissionResponderHost: {
        persistPermissionMode,
        observeHotSwitchFailure: vi.fn(),
        observeColdSwitchFailure: vi.fn(),
        now: () => 123,
      },
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
    } as unknown as SdkBridgeOptions);
    const internal = makeInternalSession({
      cwd: '/repo',
      applicationSid: 'session-a',
      permissionMode: 'plan',
    });
    internal.query = {
      setPermissionMode: querySetPermissionMode,
    } as unknown as Query;
    internal.pendingExitPlanModes.set('request-a', {
      payload: {
        type: 'exit-plan-mode',
        requestId: 'request-a',
        toolUseId: 'tool-a',
        plan: 'apply the approved plan',
      },
      toolInput: { plan: 'apply the approved plan' },
      timer: null,
      resolver,
    });
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      'session-a',
      internal,
    );

    await bridge.respondExitPlanMode('session-a', 'request-a', {
      decision: 'approve',
      targetMode: 'acceptEdits',
    });

    expect(querySetPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(persistPermissionMode).toHaveBeenCalledWith('session-a', 'acceptEdits');
    expect(resolver).toHaveBeenCalledWith({
      decision: 'approve',
      targetMode: 'acceptEdits',
    });
    expect(internal.permissionMode).toBe('acceptEdits');
  });
});
