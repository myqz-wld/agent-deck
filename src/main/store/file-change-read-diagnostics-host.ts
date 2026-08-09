import log from '@main/utils/logger';
import { setFileChangeReadDiagnostics } from './file-change-read-diagnostics-core';

const logger = log.scope('store-file-change-read-repo');

export function installDesktopFileChangeReadDiagnostics(): void {
  setFileChangeReadDiagnostics({
    warn: (message, details) => details ? logger.warn(message, details) : logger.warn(message),
  });
}
