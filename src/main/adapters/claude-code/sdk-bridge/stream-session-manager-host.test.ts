import { describe, expect, it, vi } from 'vitest';
import { createDesktopClaudeStreamProcessorHost } from './stream-processor-host';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => ({ warn: mocks.warn }),
  },
}));

vi.mock('./live-token-rate-host', () => ({
  desktopClaudeLiveRateHost: {
    resolveModel: vi.fn(() => null),
    emitTokenRateTick: vi.fn(),
  },
}));

describe('Claude stream SessionManager host', () => {
  it('delegates finalization and provider identity changes to the injected manager', () => {
    const sessionManager = {
      releaseSdkClaim: vi.fn(),
      renameSdkSession: vi.fn(),
      updateCliSessionId: vi.fn(),
    };
    const host = createDesktopClaudeStreamProcessorHost(sessionManager);

    host.finalize.releaseSdkClaim('session-a');
    host.identity.renameSdkSession('temporary-a', 'session-a');
    host.identity.updateCliSessionId('session-a', 'native-a');
    host.identity.warn('provider identity mismatch');

    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('session-a');
    expect(sessionManager.renameSdkSession).toHaveBeenCalledWith('temporary-a', 'session-a');
    expect(sessionManager.updateCliSessionId).toHaveBeenCalledWith('session-a', 'native-a');
    expect(mocks.warn).toHaveBeenCalledWith('provider identity mismatch');
  });
});
