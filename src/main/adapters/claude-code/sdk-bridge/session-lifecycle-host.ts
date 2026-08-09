import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import { runCloseSessionCleanup } from './pending-cancellation';
import type { ClaudePendingCancellationManagerPort } from './pending-cancellation-host';
import type {
  ClaudeSessionLifecycleHost,
} from './session-lifecycle-core';
import type { InternalSession, SdkBridgeOptions } from './types';

const logger = log.scope('claude-bridge');

export function createDesktopClaudeSessionLifecycleHost(
  sessionManager: ClaudePendingCancellationManagerPort,
): ClaudeSessionLifecycleHost<InternalSession, SdkBridgeOptions['emit']> {
  return {
    cleanupSession: (input) => runCloseSessionCleanup(input, sessionManager),
    hasPersistedSession: (sessionId) => Boolean(sessionRepo.get(sessionId)),
    warn: (message, error) => {
      if (error === undefined) logger.warn(message);
      else logger.warn(message, error);
    },
    info: (message) => logger.info(message),
  };
}
