import { describe, expect, it, vi } from 'vitest';

const safeDiagnostic = vi.hoisted(() => vi.fn((value) => ({ safe: value })));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@main/utils/safe-diagnostic', () => ({ safeDiagnostic }));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => ({ warn }) } }));

describe('desktop Claude fork cleanup observer', () => {
  it('owns redacted cleanup diagnostics', async () => {
    const { desktopClaudeForkCleanupObserver: observer } = await import(
      './fork-session-cleanup-host'
    );
    const error = new Error('raw failure');

    observer.recordIssue({
      phase: 'delete-native',
      targetId: 'native',
      providerName: 'Claude',
      error,
    });

    expect(safeDiagnostic).toHaveBeenCalledWith({
      phase: 'delete-native',
      outcome: 'failed',
      providerName: 'Claude',
      targetId: 'native',
      error,
    });
    expect(warn).toHaveBeenCalledWith(
      '[claude-fork] cleanup step failed',
      expect.objectContaining({ safe: expect.any(Object) }),
    );
  });
});
