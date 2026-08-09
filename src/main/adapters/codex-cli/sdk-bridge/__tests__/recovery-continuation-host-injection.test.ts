import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery-types';
import { CodexSdkBridge } from '..';
import { codexBridgeTestRuntimeHost } from './runtime-host-fixture';

interface RecoveryContinuationSeams {
  captureRecoveryContext(
    session: SessionRecord,
    overrides?: RecoveryRuntimeOverrides,
  ): CapturedRecoveryContinuation;
  prepareRecoveryContext(
    capture: CapturedRecoveryContinuation,
    continuationInstruction: string,
  ): Promise<PreparedRecoveryContinuation>;
  cleanupRecoveryContext(capture: CapturedRecoveryContinuation): void;
}

describe('Codex recovery continuation host injection', () => {
  it('routes capture, preparation, and cleanup only through the injected host', async () => {
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
    const recoveryContinuationHost = {
      captureContinuation: vi.fn(() => capture),
      prepareContinuation: vi.fn(async () => prepared),
      cleanupContinuation: vi.fn(),
    };
    const bridge = new CodexSdkBridge({
      emit: vi.fn(),
      recoveryContinuationHost,
      runtimeHost: codexBridgeTestRuntimeHost,
    }) as unknown as RecoveryContinuationSeams;
    const session = { id: 'session-a' } as SessionRecord;
    const overrides = { cwd: '/safe/project' };

    expect(bridge.captureRecoveryContext(session, overrides)).toBe(capture);
    expect(recoveryContinuationHost.captureContinuation).toHaveBeenCalledWith({
      session,
      overrides,
    });

    await expect(
      bridge.prepareRecoveryContext(capture, 'continue safely'),
    ).resolves.toBe(prepared);
    expect(recoveryContinuationHost.prepareContinuation).toHaveBeenCalledWith({
      capture,
      continuationInstruction: 'continue safely',
    });

    bridge.cleanupRecoveryContext(capture);
    expect(recoveryContinuationHost.cleanupContinuation).toHaveBeenCalledWith(capture);
  });
});
