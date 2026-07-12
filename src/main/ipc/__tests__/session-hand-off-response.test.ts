import { describe, expect, it, vi } from 'vitest';
import { HandOffExecutionError } from '@main/session/hand-off/executor';
import { serializeSessionHandOffCommit } from '../session-hand-off-response';

describe('session handoff IPC response serialization', () => {
  it('wraps a successful coordinator result with an explicit discriminant', async () => {
    await expect(
      serializeSessionHandOffCommit(
        vi.fn().mockResolvedValue({
          successorSessionId: 'successor-ok',
          cutoverEventRevision: 45,
          lateMessagesDelivered: 2,
          sourceFinalizationWarning: null,
        }),
      ),
    ).resolves.toEqual({
      status: 'success',
      successorSessionId: 'successor-ok',
      cutoverEventRevision: 45,
      lateMessagesDelivered: 2,
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
    );

    await expect(
      serializeSessionHandOffCommit(vi.fn().mockRejectedValue(executionError)),
    ).resolves.toEqual({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: 'orphan-successor-42',
      successorCleanup: 'failed',
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
      cutoverReason: 'late-message-delivery-failed',
    });
  });

  it('keeps pre-spawn and unknown failures on the rejecting IPC path', async () => {
    const failure = new Error('provider create failed before a successor existed');
    await expect(
      serializeSessionHandOffCommit(vi.fn().mockRejectedValue(failure)),
    ).rejects.toBe(failure);
  });
});
