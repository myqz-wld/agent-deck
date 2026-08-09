import { sessionRepo } from '@main/store/session-repo';
import { desktopClaudeForkCleanupObserver } from './fork-session-cleanup-host';
import {
  getClaudeConfigRoot,
  type ClaudeFamilyForkHost,
} from './fork-session-core';
import { loadSdk } from './sdk-loader';

export const desktopClaudeFamilyForkHost: ClaudeFamilyForkHost = {
  loadSdk: async () => loadSdk(),
  readConfigRoot: () => getClaudeConfigRoot(),
  childSessionStore: sessionRepo,
  cleanupObserver: desktopClaudeForkCleanupObserver,
};
