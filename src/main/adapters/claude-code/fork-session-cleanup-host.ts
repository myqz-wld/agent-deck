import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import log from '@main/utils/logger';
import type { ClaudeForkCleanupObserver } from './fork-session-cleanup-core';

const logger = log.scope('claude-native-fork');

export const desktopClaudeForkCleanupObserver: ClaudeForkCleanupObserver = {
  recordIssue: ({ phase, targetId, providerName, error }) => {
    logger.warn('[claude-fork] cleanup step failed', safeDiagnostic({
      phase,
      outcome: 'failed',
      providerName,
      targetId,
      error,
    }));
  },
};
