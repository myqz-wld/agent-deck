import { AGENT_ID } from './constants';
import { desktopClaudeLiveRateHost } from './live-token-rate-host';
import type { ClaudeStreamFinalizeHost } from './stream-finalize-core';
import type { ClaudeSessionManagerPort } from '../session-manager-core';

export function createDesktopClaudeStreamFinalizeHost(
  sessionManager: Pick<ClaudeSessionManagerPort, 'releaseSdkClaim'>,
): ClaudeStreamFinalizeHost {
  return {
    ...desktopClaudeLiveRateHost,
    agentId: AGENT_ID,
    now: () => Date.now(),
    releaseSdkClaim: (sessionId) => sessionManager.releaseSdkClaim(sessionId),
  };
}
