import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import type { ClaudePermissionResponderHost } from './permission-responder-core';

const logger = log.scope('claude-permission-responder');

export const desktopClaudePermissionResponderHost: ClaudePermissionResponderHost = {
  persistPermissionMode: (sessionId, mode) => {
    sessionRepo.setPermissionMode(sessionId, mode);
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  },
  observeHotSwitchFailure: (sessionId, error) => {
    logger.warn(`[sdk-bridge] hot-switch permission mode after approve failed: ${sessionId}`, error);
  },
  observeColdSwitchFailure: (sessionId, error) => {
    logger.error(`[sdk-bridge] cold-switch to bypass after approve failed: ${sessionId}`, error);
  },
  now: () => Date.now(),
};
