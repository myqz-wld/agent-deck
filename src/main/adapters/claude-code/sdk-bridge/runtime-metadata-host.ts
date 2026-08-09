import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import type { ClaudeRuntimeMetadataHost } from './runtime-metadata-core';

const logger = log.scope('claude-runtime-metadata');

export const desktopClaudeRuntimeMetadataHost: ClaudeRuntimeMetadataHost = {
  read: (sessionId) => sessionRepo.get(sessionId),
  setModel: (sessionId, model) => sessionRepo.setModel(sessionId, model),
  setEffort: (sessionId, effort) => sessionRepo.setThinking(sessionId, effort),
  emitUpdated: (sessionId) => {
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  },
  warnFailure: (kind, sessionId, error) => {
    const operation = kind === 'hook' ? 'runtime effort hook' : `runtime ${kind} sync`;
    logger.warn(`[claude-bridge] ${operation} failed for ${sessionId}`, error);
  },
};
