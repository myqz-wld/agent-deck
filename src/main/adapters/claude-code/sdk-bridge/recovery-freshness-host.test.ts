import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  latestConversationMessageTs: vi.fn(() => 42),
  warn: vi.fn(),
  captureRecoveryContinuation: vi.fn(() => ({
    sourceSessionId: 'session-a',
    spoolId: 'spool-a',
    generator: {},
    target: {},
    rawRetentionCeilingTokens: 1,
  })),
  prepareRecoveryContinuation: vi.fn(async () => ({
    prepared: {},
    turn: {},
    lowerBudgetRetry: null,
  })),
  cleanupRecoveryContinuation: vi.fn(),
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: { latestConversationMessageTs: mocks.latestConversationMessageTs },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: mocks.warn }) },
}));
vi.mock('@main/session/continuation-context/recovery', () => ({
  captureRecoveryContinuation: mocks.captureRecoveryContinuation,
  prepareRecoveryContinuation: mocks.prepareRecoveryContinuation,
  cleanupRecoveryContinuation: mocks.cleanupRecoveryContinuation,
}));

describe('desktop Claude recovery freshness host', () => {
  it('delegates the exact session timestamp read', async () => {
    const { desktopClaudeRecoveryFreshnessHost: host } = await import(
      './recovery-freshness-host'
    );

    expect(host.latestConversationMessageTs('session-a')).toBe(42);
    expect(mocks.latestConversationMessageTs).toHaveBeenCalledWith('session-a');

    const error = new Error('recovery warning');
    host.warn('recovery diagnostic', error);
    expect(mocks.warn).toHaveBeenCalledWith('recovery diagnostic', error);

    const captureInput = { session: { id: 'session-a' } } as never;
    const capture = host.captureContinuation(captureInput);
    expect(mocks.captureRecoveryContinuation).toHaveBeenCalledWith(captureInput);

    const prepareInput = {
      capture,
      continuationInstruction: 'continue safely',
    };
    await expect(host.prepareContinuation(prepareInput)).resolves.toEqual({
      prepared: {},
      turn: {},
      lowerBudgetRetry: null,
    });
    expect(mocks.prepareRecoveryContinuation).toHaveBeenCalledWith(prepareInput);

    host.cleanupContinuation(capture);
    expect(mocks.cleanupRecoveryContinuation).toHaveBeenCalledWith(capture);
  });
});
