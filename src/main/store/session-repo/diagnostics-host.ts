import log from '@main/utils/logger';

import { setSessionRepositoryDiagnostics } from './diagnostics-core';

const logger = log.scope('session-repo');

export function installDesktopSessionRepositoryDiagnostics(): void {
  setSessionRepositoryDiagnostics({
    warn: (message, details, error) => {
      if (error !== undefined) logger.warn(message, details, error);
      else if (details !== undefined) logger.warn(message, details);
      else logger.warn(message);
    },
  });
}
