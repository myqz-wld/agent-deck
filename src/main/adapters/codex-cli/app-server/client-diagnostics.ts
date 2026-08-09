import log from '@main/utils/logger';
import { safeErrorSummary } from '@main/utils/safe-diagnostic';
import { CodexAppServerClient } from './client';
import type { CodexAppServerOptions } from './protocol';
import type { CodexAppServerClientDiagnostics } from './client-diagnostics-port';
import type { CodexAppServerClientHost } from './client-host-port';
import { startDesktopCodexAppServerProcess } from './client-process-host';
import { codexGenerationDiagnostics } from './generation-diagnostics';
import { createAgentDeckMcpStartupObserver } from './mcp-startup-observer-adapter';
import { createDesktopCodexAppServerThread } from './thread-diagnostics';
import { prepareNodeReplBrowserBootstrap } from './node-repl-browser-bootstrap-adapter';
import {
  logCodexRecycleCompleted,
  logCodexRecycleDetachFailure,
  logCodexRecycleSkipped,
  logCodexTerminationFailure,
} from './recycle-logging';

const logger = log.scope('codex-app-server');

export const desktopCodexClientDiagnostics: CodexAppServerClientDiagnostics = {
  interruptWriteFailed: (input) => {
    logger.debug('[codex-app-server] turn interrupt write failed', {
      event: 'codex_turn_interrupt_write_failed',
      ...input,
    });
  },
  stderrActivity: (input) => {
    logger.debug('[codex-app-server] stderr activity', {
      event: 'codex_app_server_stderr',
      ...input,
    });
  },
  stdoutParseFailed: (input) => {
    logger.warn('[codex-app-server] failed to parse stdout line', {
      event: 'codex_app_server_stdout_parse_failed',
      ...input,
    });
  },
  mcpStartupObserved: (input) => {
    logger[input.level](input.message);
  },
  notificationListenerFailed: (error) => {
    logger.warn(
      '[codex-app-server] notification listener failed',
      safeErrorSummary(error),
    );
  },
  recycleSkipped: (context, outcome) => {
    logCodexRecycleSkipped(logger, context, outcome);
  },
  recycleDetachFailed: (context, after, interruptWrite) => {
    logCodexRecycleDetachFailure(logger, context, after, interruptWrite);
  },
  recycleTerminationFailed: (context, signal) => {
    logCodexTerminationFailure(logger, context, signal);
  },
  recycleCompleted: (context, after, interruptWrite, termination) => {
    logCodexRecycleCompleted(logger, context, after, interruptWrite, termination);
  },
};

export const desktopCodexClientHost: CodexAppServerClientHost = {
  ...desktopCodexClientDiagnostics,
  generationDiagnostics: codexGenerationDiagnostics,
  createMcpStartupObserver: createAgentDeckMcpStartupObserver,
  createThread: createDesktopCodexAppServerThread,
  prepareThreadOptions: prepareNodeReplBrowserBootstrap,
  startProcess: startDesktopCodexAppServerProcess,
};

/** Desktop factory; the app-server process client itself owns no logger singleton. */
export function createDesktopCodexAppServerClient(
  options: CodexAppServerOptions,
): CodexAppServerClient {
  return new CodexAppServerClient(options, desktopCodexClientHost);
}
