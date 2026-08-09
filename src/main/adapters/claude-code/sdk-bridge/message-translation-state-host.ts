import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import type { ClaudeMessageTranslationStateHost } from './message-translation-state-core';

export const desktopClaudeMessageTranslationStateHost: ClaudeMessageTranslationStateHost = {
  read: (sessionId) => sessionRepo.get(sessionId),
  setPermissionMode: (sessionId, mode) => sessionRepo.setPermissionMode(sessionId, mode),
  publishUpdated: (sessionId) => {
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  },
};
