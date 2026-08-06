import { sessionRepo } from '@main/store/session-repo';
import type { ClaudeCwdTransitionHost } from './cwd-transition-controller-core';

export const desktopClaudeCwdTransitionHost: ClaudeCwdTransitionHost = {
  getSession: (sessionId) => sessionRepo.get(sessionId),
};
