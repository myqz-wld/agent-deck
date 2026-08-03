import { sessionManager } from '@main/session/manager';
import log from '@main/utils/logger';

const logger = log.scope('grok-build-bridge');

/** Remove a newly registered strict-startup row after its provider runtime has been disposed. */
export async function cleanupFailedGrokStartupRegistration(sessionId: string): Promise<void> {
  try {
    await sessionManager.delete(sessionId);
  } catch (error) {
    logger.warn(`[grok-build] failed to remove strict-startup session ${sessionId}`, error);
    // Deletion guards may reject even though the provider process is already gone. A closed row is
    // the conservative fallback and must not remain advertised as an active target.
    sessionManager.markClosed(sessionId);
  }
}
