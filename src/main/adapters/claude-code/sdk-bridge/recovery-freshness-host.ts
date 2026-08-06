import { eventRepo } from '@main/store/event-repo';
import log from '@main/utils/logger';
import { desktopRecoveryContinuationHost } from '@main/session/continuation-context/recovery-host';
import type { ClaudeRecoveryFreshnessHost } from './recovery-freshness-host-core';

const logger = log.scope('claude-recoverer');

export const desktopClaudeRecoveryFreshnessHost: ClaudeRecoveryFreshnessHost = {
  ...desktopRecoveryContinuationHost,
  latestConversationMessageTs: (sessionId) => eventRepo.latestConversationMessageTs(sessionId),
  warn: (message, error) => logger.warn(message, error),
};
