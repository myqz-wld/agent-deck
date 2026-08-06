import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import type { ClaudeRestartSessionHost } from './restart-session-host-core';

const logger = log.scope('claude-restart-controller');

function publishUpdated(sessionId: string): void {
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

export const desktopClaudeRestartSessionHost: ClaudeRestartSessionHost = {
  readSession: (sessionId) => sessionRepo.get(sessionId),
  setPermissionModeAndPublish: (sessionId, mode) => {
    sessionRepo.setPermissionMode(sessionId, mode);
    publishUpdated(sessionId);
  },
  setSandboxAndPublish: (sessionId, sandbox) => {
    sessionRepo.setClaudeCodeSandbox(sessionId, sandbox);
    publishUpdated(sessionId);
  },
  subscribeRenames: (listener) => {
    eventBus.on('session-renamed', listener);
    return () => eventBus.off('session-renamed', listener);
  },
  warn: (message, error) => logger.warn(message, error),
};
