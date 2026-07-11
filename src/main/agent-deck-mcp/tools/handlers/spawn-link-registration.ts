import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';

const logger = log.scope('mcp-spawn');

/** Idempotent canonical-id fallback for adapters that cannot link their first SDK row directly. */
export function persistSpawnLinkFallback(input: {
  sessionId: string;
  parentSessionId: string;
  depth: number;
}): void {
  try {
    sessionRepo.setSpawnLink(input.sessionId, input.parentSessionId, input.depth);
  } catch (error) {
    // Provider creation already succeeded. Reporting total spawn failure would invite a retry and
    // orphan a live duplicate, so preserve success and leave the degraded flat row visible in logs.
    logger.warn(
      `[mcp spawn_session] setSpawnLink(${input.sessionId}, ${input.parentSessionId}, ${input.depth}) failed; spawnedBy left NULL:`,
      error,
    );
    return;
  }

  try {
    const linked = sessionRepo.get(input.sessionId);
    if (linked) eventBus.emit('session-upserted', linked);
  } catch (error) {
    logger.warn(
      `[mcp spawn_session] session-upserted emit after setSpawnLink(${input.sessionId}) failed:`,
      error,
    );
  }
}
