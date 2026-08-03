import { describe, expect, it, vi } from 'vitest';
import { HandOffExecutionError } from '@main/session/hand-off/executor';
import { TrustedContinuationStartupFailure } from '@main/session/hand-off/trusted-continuation-gate';
import { serializeSessionHandOffCommit } from '../session-hand-off-response';

describe('session handoff IPC response serialization', () => {
  it('wraps a successful coordinator result with an explicit discriminant', async () => {
    await expect(
      serializeSessionHandOffCommit(
        vi.fn().mockResolvedValue({
          successorSessionId: 'successor-ok',
          cutoverEventRevision: 45,
          lateMessagesDelivered: 2,
          usedLowerBudgetRetry: false,
          sourceFinalizationWarning: null,
        }),
      ),
    ).resolves.toEqual({
      status: 'success',
      successorSessionId: 'successor-ok',
      cutoverEventRevision: 45,
      lateMessagesDelivered: 2,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null,
    });
  });

  it('preserves stage, stable successor identity, and failed cleanup as serializable data', async () => {
    const executionError = new HandOffExecutionError(
      'source drifted after successor creation',
      'cutover',
      'orphan-successor-42',
      'failed',
      null,
      null,
      null,
      true,
    );

    await expect(
      serializeSessionHandOffCommit(vi.fn().mockRejectedValue(executionError)),
    ).resolves.toEqual({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: 'orphan-successor-42',
      successorCleanup: 'failed',
      usedLowerBudgetRetry: true,
      message: 'source drifted after successor creation',
    });
  });

  it('preserves the cutover reason needed for actionable late-delivery UI copy', async () => {
    const executionError = new HandOffExecutionError(
      'late delivery failed',
      'cutover',
      'orphan-successor-43',
      'ok',
      null,
      'queue full',
      'late-message-delivery-failed',
    );

    await expect(
      serializeSessionHandOffCommit(vi.fn().mockRejectedValue(executionError)),
    ).resolves.toMatchObject({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: 'orphan-successor-43',
      successorCleanup: 'ok',
      usedLowerBudgetRetry: false,
      cutoverReason: 'late-message-delivery-failed',
    });
  });

  it('serializes a startup deadline without fabricating a successor identity', async () => {
    const executionError = new HandOffExecutionError(
      'startup deadline expired',
      'cutover',
      null,
      'pending',
      null,
      null,
      'target-startup-timeout',
      true,
    );

    await expect(
      serializeSessionHandOffCommit(vi.fn().mockRejectedValue(executionError)),
    ).resolves.toEqual({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: null,
      successorCleanup: 'pending',
      usedLowerBudgetRetry: true,
      cutoverReason: 'target-startup-timeout',
      message: 'startup deadline expired',
    });
  });

  it('serializes a terminal lower-budget startup rejection without an orphan', async () => {
    const executionError = new HandOffExecutionError(
      'lower-budget startup failed',
      'cutover',
      null,
      'ok',
      null,
      null,
      'target-retry-startup-failed',
      true,
    );

    await expect(
      serializeSessionHandOffCommit(vi.fn().mockRejectedValue(executionError)),
    ).resolves.toEqual({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: null,
      successorCleanup: 'ok',
      usedLowerBudgetRetry: true,
      cutoverReason: 'target-retry-startup-failed',
      message: 'lower-budget startup failed',
    });
  });

  it('keeps pre-spawn and unknown failures on the rejecting IPC path', async () => {
    const failure = new Error('provider create failed before a successor existed');
    await expect(
      serializeSessionHandOffCommit(vi.fn().mockRejectedValue(failure)),
    ).rejects.toBe(failure);
  });

  it('projects a primary startup failure without exposing provider diagnostics', async () => {
    const privateDetail = 'PRIVATE_PROVIDER_STARTUP_DETAIL';
    const failure = new TrustedContinuationStartupFailure();
    Object.defineProperty(failure, 'privateDetail', { value: privateDetail });

    let projected: unknown;
    try {
      await serializeSessionHandOffCommit(vi.fn().mockRejectedValue(failure));
    } catch (error) {
      projected = error;
    }

    expect(projected).toBeInstanceOf(Error);
    expect((projected as Error).message).toContain('目标 provider 未能');
    expect((projected as Error).message).not.toContain(privateDetail);
  });
});
