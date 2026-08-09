import log from '@main/utils/logger';
import { setHandOffDiagnostics } from './diagnostics-core';

const handOffLogger = log.scope('handoff');

/** Install Electron-main diagnostics without pulling Electron into the headless Core graph. */
export function installDesktopHandOffDiagnostics(): void {
  setHandOffDiagnostics({
    warn: (message, error) => handOffLogger.warn(message, error),
  });
}
