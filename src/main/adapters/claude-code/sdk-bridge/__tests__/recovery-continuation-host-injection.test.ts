import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery-types';
import { ClaudeSdkBridge } from '..';
import type { SdkBridgeOptions } from '../types';

interface RecoveryContinuationSeams {
  captureRecoveryContinuation(input: {
    session: SessionRecord;
    overrides?: RecoveryRuntimeOverrides;
  }): CapturedRecoveryContinuation;
  prepareRecoveryContinuation(input: {
    capture: CapturedRecoveryContinuation;
    continuationInstruction: string;
    signal?: AbortSignal;
  }): Promise<PreparedRecoveryContinuation>;
  cleanupRecoveryContinuation(capture: CapturedRecoveryContinuation): void;
}

describe('Claude recovery continuation host injection', () => {
  it('routes capture, preparation, and cleanup only through the injected recovery host', async () => {
    const capture = {
      sourceSessionId: 'session-a',
      spoolId: 'spool-a',
      generator: {},
      target: {},
      rawRetentionCeilingTokens: 1,
    } as CapturedRecoveryContinuation;
    const prepared = {
      prepared: {},
      turn: {},
      lowerBudgetRetry: null,
    } as PreparedRecoveryContinuation;
    const recoveryFreshnessHost = {
      latestConversationMessageTs: vi.fn(() => null),
      warn: vi.fn(),
      captureContinuation: vi.fn(() => capture),
      prepareContinuation: vi.fn(async () => prepared),
      cleanupContinuation: vi.fn(),
    };
    const bridge = new ClaudeSdkBridge({
      createSessionHost: {},
      jsonlDiscoveryHost: {},
      recoveryFreshnessHost,
      restartSessionHost: {},
      sessionModelHost: {},
      usageSnapshotHost: {},
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
    } as unknown as SdkBridgeOptions) as unknown as RecoveryContinuationSeams;

    const captureInput = { session: { id: 'session-a' } as SessionRecord };
    expect(bridge.captureRecoveryContinuation(captureInput)).toBe(capture);
    expect(recoveryFreshnessHost.captureContinuation).toHaveBeenCalledWith(captureInput);

    const prepareInput = { capture, continuationInstruction: 'continue safely' };
    await expect(bridge.prepareRecoveryContinuation(prepareInput)).resolves.toBe(prepared);
    expect(recoveryFreshnessHost.prepareContinuation).toHaveBeenCalledWith(prepareInput);

    bridge.cleanupRecoveryContinuation(capture);
    expect(recoveryFreshnessHost.cleanupContinuation).toHaveBeenCalledWith(capture);
  });
});
