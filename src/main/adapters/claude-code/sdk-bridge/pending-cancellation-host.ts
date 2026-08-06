import { cleanupGatewaySandboxSettings } from './create-session/gateway-sandbox-settings';
import type { ClaudePendingCancellationHost } from './pending-cancellation-core';
import type { InternalSession } from './types';
import type { ClaudeSessionManagerPort } from '../session-manager-core';

export type ClaudePendingCancellationManagerPort = Pick<
  ClaudeSessionManagerPort,
  'releaseSdkClaim' | 'markRecentlyDeleted'
>;

export function createDesktopClaudePendingCancellationHost(
  sessionManager: ClaudePendingCancellationManagerPort,
): ClaudePendingCancellationHost<InternalSession> {
  return {
    now: () => Date.now(),
    cleanupGatewaySandboxSettings,
    releaseSdkClaim: (sessionId) => sessionManager.releaseSdkClaim(sessionId),
    markRecentlyDeleted: (sessionId) => sessionManager.markRecentlyDeleted(sessionId),
  };
}
