import { describe, expect, it, vi } from 'vitest';
import type { TrustedContinuationInitialTurn } from '../../continuation-context/initial-turn';
import {
  selectTrustedContinuationCandidate,
  TrustedContinuationStartupFailure,
} from '../trusted-continuation-gate';

const primaryTurn = { kind: 'trusted-continuation' } as TrustedContinuationInitialTurn;

function input(capacityStatus: 'observed' | 'unknown') {
  return {
    capacityStatus,
    primaryTurn,
    lowerBudgetRetryTurn: null,
    createCandidate: vi.fn(),
    rollbackRejectedCandidate: vi.fn(async () => undefined),
    closeCandidateBestEffort: vi.fn(async () => undefined),
  };
}

describe('trusted continuation primary startup failures', () => {
  it.each([
    { label: 'observed synchronous', capacityStatus: 'observed' as const, synchronous: true },
    { label: 'unknown asynchronous', capacityStatus: 'unknown' as const, synchronous: false },
  ])('sanitizes $label rejection while preserving the pre-spawn retry class', async ({
    capacityStatus,
    synchronous,
  }) => {
    const privateDetail = 'PRIVATE_PRIMARY_STARTUP_DETAIL';
    const current = input(capacityStatus);
    if (synchronous) {
      current.createCandidate.mockImplementation(() => {
        throw new Error(privateDetail);
      });
    } else {
      current.createCandidate.mockRejectedValue(new Error(privateDetail));
    }

    let failure: unknown;
    try {
      await selectTrustedContinuationCandidate(current);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TrustedContinuationStartupFailure);
    expect((failure as Error).message).not.toContain(privateDetail);
    expect(current.closeCandidateBestEffort).not.toHaveBeenCalled();
  });
});
