import log from '@main/utils/logger';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';
import type { CodexGenerationDiagnostics } from './generation-operation';
import { logCodexThreadBoundaryReady } from './thread-boundary-logging';

const logger = log.scope('codex-app-server');

export const codexGenerationDiagnostics: CodexGenerationDiagnostics = {
  threadBoundaryReady: logCodexThreadBoundaryReady,
  threadBoundaryFailed: (input) => {
    logger.warn(
      '[codex-app-server] thread boundary failed before readiness',
      safeDiagnostic({
        event: 'codex_app_server_thread_boundary',
        phase: input.method,
        outcome: 'failed',
        threadShort: input.thread.slice(0, 12),
        durationMs: input.durationMs,
        error: safeErrorSummary(input.error),
      }),
    );
  },
  initializeFailed: (input) => {
    logger.warn(
      '[codex-app-server] initialize failed; next request will retry',
      safeDiagnostic({
        event: 'codex_app_server_initialize',
        phase: 'initialize',
        outcome: 'failed_retryable',
        processGeneration: input.processGeneration,
        error: safeErrorSummary(input.error),
      }),
    );
  },
  terminationFailed: (input) => {
    if (input.operation === 'control-plane-recycle') {
      logger.warn(
        '[codex-app-server] control-plane recycle termination failed',
        safeDiagnostic({
          event: 'codex_app_server_control_plane_recycle_termination_failed',
          phase: input.phase,
          expectedGeneration: input.expectedGeneration,
          actualGeneration: input.actualGeneration,
          signal: input.signal,
        }),
      );
      return;
    }
    logger.warn(
      '[codex-app-server] disposed child termination failed',
      safeDiagnostic({
        event: 'codex_app_server_dispose_termination_failed',
        processGeneration: input.actualGeneration,
        signal: input.signal,
      }),
    );
  },
  extraRootsFailed: (error) => {
    logger.warn(
      '[codex-app-server] skills/extraRoots/set failed',
      safeErrorSummary(error),
    );
  },
  controlPlaneRecycled: (input) => {
    logger[input.outcome === 'retired_expected' ? 'info' : 'warn'](
      '[codex-app-server] control-plane generation recycled',
      safeDiagnostic({
        event: 'codex_app_server_control_plane_recycle',
        ...input,
      }),
    );
  },
};
