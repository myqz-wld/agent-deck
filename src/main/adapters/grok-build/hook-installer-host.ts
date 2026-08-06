import log from '@main/utils/logger';
import type { GrokHookInstallerObserver } from './hook-installer';

const logger = log.scope('grok-hook-installer');

export const desktopGrokHookInstallerObserver: GrokHookInstallerObserver = {
  statusReadFailed: (error) => {
    logger.warn('[grok-hook-installer] status readHookConfig failed:', error);
  },
};
