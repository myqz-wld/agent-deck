import log from '@main/utils/logger';

const logger = log.scope('codex-app-server');
const SLOW_THREAD_BOUNDARY_MS = 30_000;

export function threadBoundaryReadyLogLevel(durationMs: number): 'debug' | 'warn' {
  return durationMs >= SLOW_THREAD_BOUNDARY_MS ? 'warn' : 'debug';
}

export function logCodexThreadBoundaryReady(input: {
  method: string;
  thread: string;
  durationMs: number;
}): void {
  const message =
    `[codex-app-server] ${input.method} ready ` +
    `(thread=${input.thread}, durationMs=${input.durationMs})`;
  if (threadBoundaryReadyLogLevel(input.durationMs) === 'warn') {
    logger.warn(`[performance] slow ${message}`);
  } else {
    logger.debug(message);
  }
}
