import log from '@main/utils/logger';
import type { ClaudeHookInstallerObserver } from './hook-installer-core';

const logger = log.scope('claude-hook-installer');

export const desktopClaudeHookInstallerObserver: ClaudeHookInstallerObserver = {
  statusReadFailed: (error) => {
    logger.warn('[hook-installer] status readHookConfig failed:', error);
  },
};
