import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TrustedContinuationAcceptance,
  TrustedContinuationSessionCandidate,
} from '@main/adapters/trusted-continuation';
import type { TrustedContinuationInitialTurn } from '../../continuation-context/initial-turn';
import {
  selectTrustedContinuationCandidate,
  TrustedContinuationGateFailure,
} from '../trusted-continuation-gate';

const primaryTurn = { kind: 'trusted-continuation' } as TrustedContinuationInitialTurn;
const retryTurn = {
  kind: 'trusted-continuation',
  providerPrompt: 'lower',
} as TrustedContinuationInitialTurn;

function candidate(
  sessionId: string,
  acceptance: TrustedContinuationAcceptance | Promise<TrustedContinuationAcceptance>,
): TrustedContinuationSessionCandidate {
  return { sessionId, acceptance: Promise.resolve(acceptance) };
}

function pendingCandidate(sessionId: string): {
  candidate: TrustedContinuationSessionCandidate;
  settle: (result: TrustedContinuationAcceptance) => void;
} {
  let settle!: (result: TrustedContinuationAcceptance) => void;
  return {
    candidate: {
      sessionId,
      acceptance: new Promise((resolve) => { settle = resolve; }),
    },
    settle,
  };
}

function accepted(sessionId: string): TrustedContinuationSessionCandidate {
  return candidate(sessionId, { status: 'accepted', boundary: 'model-activity' });
}

function baseInput() {
  return {
    capacityStatus: 'unknown' as const,
    primaryTurn,
    lowerBudgetRetryTurn: retryTurn,
    createCandidate: vi.fn(async () => accepted('primary')),
    rollbackRejectedCandidate: vi.fn(async () => undefined),
    closeCandidateBestEffort: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('trusted continuation readiness gate', () => {
  it('observed target keeps the current no-wait fast path', async () => {
    const pending = pendingCandidate('fast');
    const input = baseInput();
    input.createCandidate.mockResolvedValue(pending.candidate);

    await expect(selectTrustedContinuationCandidate({
      ...input,
      capacityStatus: 'observed',
    })).resolves.toEqual({ candidate: pending.candidate, usedLowerBudgetRetry: false });
    expect(input.rollbackRejectedCandidate).not.toHaveBeenCalled();
    expect(input.closeCandidateBestEffort).not.toHaveBeenCalled();
  });

  it.each(['stale', 'unknown'] as const)(
    'waits for %s-target native model activity before accepting the primary',
    async (capacityStatus) => {
      const pending = pendingCandidate('primary');
      const input = baseInput();
      input.createCandidate.mockResolvedValue(pending.candidate);
      const selection = selectTrustedContinuationCandidate({ ...input, capacityStatus });

      await Promise.resolve();
      let settled = false;
      void selection.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      pending.settle({ status: 'accepted', boundary: 'model-activity' });
      await expect(selection).resolves.toEqual({
        candidate: pending.candidate,
        usedLowerBudgetRetry: false,
      });
    },
  );

  it('strictly removes a context-rejected primary then accepts exactly one lower candidate', async () => {
    const input = baseInput();
    const primary = candidate('primary', {
      status: 'rejected', reason: 'context-window-exceeded',
    });
    const retry = accepted('retry');
    input.createCandidate
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(retry);

    await expect(selectTrustedContinuationCandidate(input)).resolves.toEqual({
      candidate: retry,
      usedLowerBudgetRetry: true,
    });
    expect(input.createCandidate).toHaveBeenNthCalledWith(1, primaryTurn);
    expect(input.createCandidate).toHaveBeenNthCalledWith(2, retryTurn);
    expect(input.rollbackRejectedCandidate).toHaveBeenCalledWith('primary');
    expect(input.closeCandidateBestEffort).not.toHaveBeenCalled();
  });

  it('does not retry when strict primary cleanup cannot be proved', async () => {
    const input = baseInput();
    input.createCandidate.mockResolvedValue(candidate('primary', {
      status: 'rejected', reason: 'context-window-exceeded',
    }));
    input.rollbackRejectedCandidate.mockRejectedValue(new Error('still live'));

    await expect(selectTrustedContinuationCandidate(input)).rejects.toMatchObject({
      name: 'TrustedContinuationGateFailure',
      successorSessionId: 'primary',
      successorCleanup: 'failed',
      reason: 'target-rollback-failed',
      usedLowerBudgetRetry: false,
    } satisfies Partial<TrustedContinuationGateFailure>);
    expect(input.createCandidate).toHaveBeenCalledTimes(1);
  });

  it('never retries an unclassified provider rejection', async () => {
    const input = baseInput();
    input.createCandidate.mockResolvedValue(candidate('primary', {
      status: 'rejected', reason: 'provider-error',
    }));

    await expect(selectTrustedContinuationCandidate(input)).rejects.toMatchObject({
      reason: 'target-provider-rejected',
      successorCleanup: 'ok',
    });
    expect(input.closeCandidateBestEffort).toHaveBeenCalledWith('primary');
    expect(input.createCandidate).toHaveBeenCalledTimes(1);
  });

  it('closes a rejected lower candidate and never creates a third candidate', async () => {
    const input = baseInput();
    input.createCandidate
      .mockResolvedValueOnce(candidate('primary', {
        status: 'rejected', reason: 'context-window-exceeded',
      }))
      .mockResolvedValueOnce(candidate('retry', {
        status: 'rejected', reason: 'context-window-exceeded',
      }));

    await expect(selectTrustedContinuationCandidate(input)).rejects.toMatchObject({
      reason: 'target-retry-rejected',
      successorSessionId: 'retry',
      usedLowerBudgetRetry: true,
    });
    expect(input.closeCandidateBestEffort).toHaveBeenCalledWith('retry');
    expect(input.createCandidate).toHaveBeenCalledTimes(2);
  });

  it('makes a lower-candidate startup rejection terminal without inventing an orphan', async () => {
    const input = baseInput();
    input.createCandidate
      .mockResolvedValueOnce(candidate('primary', {
        status: 'rejected', reason: 'context-window-exceeded',
      }))
      .mockRejectedValueOnce(new Error('private retry startup detail'));

    await expect(selectTrustedContinuationCandidate(input)).rejects.toMatchObject({
      reason: 'target-retry-startup-failed',
      successorSessionId: null,
      successorCleanup: 'ok',
      usedLowerBudgetRetry: true,
    });
    expect(input.rollbackRejectedCandidate).toHaveBeenCalledWith('primary');
    expect(input.closeCandidateBestEffort).not.toHaveBeenCalled();
    expect(input.createCandidate).toHaveBeenCalledTimes(2);
  });

  it('uses one absolute deadline and starts best-effort cleanup on timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const pending = pendingCandidate('timed-out');
    const input = baseInput();
    input.createCandidate.mockResolvedValue(pending.candidate);
    const selection = selectTrustedContinuationCandidate({ ...input, deadlineMs: 50 });
    const assertion = expect(selection).rejects.toMatchObject({
      reason: 'target-acceptance-timeout',
      successorSessionId: 'timed-out',
    });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(input.closeCandidateBestEffort).toHaveBeenCalledWith('timed-out');
    expect(input.createCandidate).toHaveBeenCalledTimes(1);
  });

  it('makes a primary startup deadline terminal while closing a candidate that materializes late', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(15_000);
    let resolveCreation!: (value: TrustedContinuationSessionCandidate) => void;
    const creation = new Promise<TrustedContinuationSessionCandidate>((resolve) => {
      resolveCreation = resolve;
    });
    const input = baseInput();
    input.createCandidate.mockImplementationOnce(() => creation);
    const selection = selectTrustedContinuationCandidate({ ...input, deadlineMs: 50 });
    const assertion = expect(selection).rejects.toMatchObject({
      reason: 'target-startup-timeout',
      successorSessionId: null,
      successorCleanup: 'pending',
      usedLowerBudgetRetry: false,
    });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(input.closeCandidateBestEffort).not.toHaveBeenCalled();

    resolveCreation(accepted('late-primary'));
    await vi.waitFor(() => {
      expect(input.closeCandidateBestEffort).toHaveBeenCalledWith('late-primary');
    });
  });

  it('does not report pending cleanup when the deadline expires before creation starts', async () => {
    const input = baseInput();

    await expect(selectTrustedContinuationCandidate({
      ...input,
      deadlineMs: 0,
    })).rejects.toMatchObject({
      reason: 'target-startup-timeout',
      successorSessionId: null,
      successorCleanup: 'ok',
      usedLowerBudgetRetry: false,
    });
    expect(input.createCandidate).not.toHaveBeenCalled();
    expect(input.closeCandidateBestEffort).not.toHaveBeenCalled();
  });

  it('attributes a retry startup deadline to the lower-budget attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(17_000);
    let resolveRetry!: (value: TrustedContinuationSessionCandidate) => void;
    const retryCreation = new Promise<TrustedContinuationSessionCandidate>((resolve) => {
      resolveRetry = resolve;
    });
    const input = baseInput();
    input.createCandidate
      .mockResolvedValueOnce(candidate('primary', {
        status: 'rejected', reason: 'context-window-exceeded',
      }))
      .mockImplementationOnce(() => retryCreation);
    const selection = selectTrustedContinuationCandidate({ ...input, deadlineMs: 50 });
    const assertion = expect(selection).rejects.toMatchObject({
      reason: 'target-startup-timeout',
      successorSessionId: null,
      successorCleanup: 'pending',
      usedLowerBudgetRetry: true,
    });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(input.rollbackRejectedCandidate).toHaveBeenCalledWith('primary');

    resolveRetry(accepted('late-retry'));
    await vi.waitFor(() => {
      expect(input.closeCandidateBestEffort).toHaveBeenCalledWith('late-retry');
    });
  });

  it('does not attribute a retry when the deadline jumps forward before retry creation', async () => {
    const input = baseInput();
    input.createCandidate.mockResolvedValueOnce(candidate('primary', {
      status: 'rejected', reason: 'context-window-exceeded',
    }));
    const times = [0, 0, 0, 0, 0, 99, 100];

    await expect(selectTrustedContinuationCandidate({
      ...input,
      deadlineMs: 100,
      now: () => times.shift() ?? 100,
    })).rejects.toMatchObject({
      reason: 'target-startup-timeout',
      successorSessionId: null,
      successorCleanup: 'ok',
      usedLowerBudgetRetry: false,
    });
    expect(input.rollbackRejectedCandidate).toHaveBeenCalledWith('primary');
    expect(input.createCandidate).toHaveBeenCalledTimes(1);
  });

  it('does not start the lower candidate after strict cleanup consumes the shared deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const input = baseInput();
    input.createCandidate.mockResolvedValue(candidate('primary', {
      status: 'rejected', reason: 'context-window-exceeded',
    }));
    input.rollbackRejectedCandidate.mockImplementation(
      () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
    );
    const selection = selectTrustedContinuationCandidate({ ...input, deadlineMs: 50 });
    const assertion = expect(selection).rejects.toMatchObject({
      reason: 'target-acceptance-timeout',
      successorSessionId: 'primary',
      successorCleanup: 'ok',
      usedLowerBudgetRetry: false,
    });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(input.createCandidate).toHaveBeenCalledTimes(1);
  });
});
