import log from '@main/utils/logger';

const logger = log.scope('codex-app-server-translate');
const streamLogger = log.scope('codex-stream-error-classifier');
const SAFE_ITEM_TYPE = /^[A-Za-z][A-Za-z0-9./_-]{0,79}$/;

/** Desktop logging adapter for ignored future app-server item types. */
export function observeIgnoredCodexAppServerItemType(itemType: string): void {
  const safeType = SAFE_ITEM_TYPE.test(itemType) ? itemType : 'unknown';
  logger.debug(`[codex-app-server-translate] ignored item type: ${safeType}`);
}

/** Preserve the existing heuristic-only warning outside the pure classifier. */
export function observeHeuristicCodexStreamError(message: string): void {
  streamLogger.warn(
    `[codex-cli/stream-error-classifier] heuristic-only transient match (consider adding to white-list): ${message}`,
  );
}
