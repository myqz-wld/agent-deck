import log from '@main/utils/logger';

import { setEventRepositoryDiagnostics } from './event-repo-diagnostics-core';

const logger = log.scope('event-repo');

export function installDesktopEventRepositoryDiagnostics(): void {
  setEventRepositoryDiagnostics({
    warn: (message, details, error) => {
      if (error !== undefined) logger.warn(message, details, error);
      else if (details !== undefined) logger.warn(message, details);
      else logger.warn(message);
    },
  });
}
