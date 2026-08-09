import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import type { SessionModelControllerHost } from './session-model-controller-core';

const logger = log.scope('session-model-controller');

export const desktopSessionModelControllerHost: SessionModelControllerHost = {
  read: (sessionId) => sessionRepo.get(sessionId),
  setRuntimeProvider: (sessionId, provider) =>
    sessionRepo.setRuntimeProvider(sessionId, provider),
  setModel: (sessionId, model) => sessionRepo.setModel(sessionId, model),
  setThinking: (sessionId, thinking) => sessionRepo.setThinking(sessionId, thinking),
  publishUpdated: (sessionId) => {
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  },
  now: () => Date.now(),
  info: (message) => logger.info(message),
  warn: (message, error) => logger.warn(message, error),
};
