import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TrustedContinuationAcceptance,
  TrustedContinuationSessionCandidate,
} from '@main/adapters/trusted-continuation';
import type { TrustedContinuationInitialTurn } from '../../continuation-context/initial-turn';
import { selectTrustedContinuationCandidate } from '../trusted-continuation-gate';

const primaryTurn = { kind: 'trusted-continuation' } as TrustedContinuationInitialTurn;
const retryTurn = {
  kind: 'trusted-continuation',
  providerPrompt: 'lower',
} as TrustedContinuationInitialTurn;

function candidate(
  sessionId: string,
  acceptance: TrustedContinuationAcceptance,
): TrustedContinuationSessionCandidate {
  return { sessionId, acceptance: Promise.resolve(acceptance) };
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

describe('trusted continuation entry-expiry cleanup', () => {
  it.each([
    { label: 'fulfilled primary', retry: false, state: 'fulfilled' as const },
    { label: 'unresolved primary', retry: false, state: 'unresolved' as const },
    { label: 'fulfilled retry', retry: true, state: 'fulfilled' as const },
    { label: 'unresolved retry', retry: true, state: 'unresolved' as const },
  ])('keeps $label startup pending until its candidate is closed', async ({ retry, state }) => {
    vi.useFakeTimers();
    let monotonicMs = 0;
    let resolveCreation!: (candidate: TrustedContinuationSessionCandidate) => void;
    const unresolvedCreation = new Promise<TrustedContinuationSessionCandidate>((resolve) => {
      resolveCreation = resolve;
    });
    const lateSessionId = retry ? 'late-retry' : 'late-primary';
    const input = baseInput();
    if (retry) {
      input.createCandidate.mockResolvedValueOnce(candidate('primary', {
        status: 'rejected', reason: 'context-window-exceeded',
      }));
    }
    input.createCandidate.mockImplementationOnce(() => {
      monotonicMs = 51;
      return state === 'fulfilled'
        ? Promise.resolve(accepted(lateSessionId))
        : unresolvedCreation;
    });

    await expect(selectTrustedContinuationCandidate({
      ...input,
      deadlineMs: 50,
      now: () => monotonicMs,
    })).rejects.toMatchObject({
      reason: 'target-startup-timeout',
      successorSessionId: null,
      successorCleanup: 'pending',
      usedLowerBudgetRetry: retry,
    });

    expect(input.createCandidate).toHaveBeenCalledTimes(retry ? 2 : 1);
    if (retry) expect(input.rollbackRejectedCandidate).toHaveBeenCalledWith('primary');
    if (state === 'unresolved') {
      expect(input.closeCandidateBestEffort).not.toHaveBeenCalled();
      resolveCreation(accepted(lateSessionId));
    }
    await vi.waitFor(() => {
      expect(input.closeCandidateBestEffort).toHaveBeenCalledTimes(1);
      expect(input.closeCandidateBestEffort).toHaveBeenCalledWith(lateSessionId);
    });
  });
});
