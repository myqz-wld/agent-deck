import log from '@main/utils/logger';
import type { CodexAppServerClient } from './client';
import { CodexAppServerThread } from './thread';
import type { CodexThreadMode } from './thread-mode';
import type {
  CodexThreadDiagnostics,
  CodexThreadWatchdogDiagnostic,
} from './thread-diagnostics-port';

const logger = log.scope('codex-app-server');

const codexThreadDiagnostics: CodexThreadDiagnostics = {
  firstModelEventReceived: (diagnostic) => {
    logger.debug('[codex-app-server] first model event received', diagnostic);
  },
  watchdogArmed: (diagnostic) => {
    logger.debug('[codex-app-server] turn accepted; first-model watchdog armed', diagnostic);
  },
  watchdogTimedOut: (diagnostic) => {
    logger.warn(
      '[codex-app-server] first model event timeout; recycle initiated',
      diagnostic,
    );
  },
};

/** Desktop thread factory; the thread state machine itself owns no logger singleton. */
export function createDesktopCodexAppServerThread(
  client: CodexAppServerClient,
  mode: CodexThreadMode,
  attachedGeneration?: number,
  initialRuntime?: unknown,
): CodexAppServerThread {
  return new CodexAppServerThread(
    client,
    mode,
    attachedGeneration,
    initialRuntime,
    codexThreadDiagnostics,
  );
}

export type { CodexThreadWatchdogDiagnostic };
