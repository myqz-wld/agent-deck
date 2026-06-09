import type { spawnSessionHandler } from '../spawn';
import type { transferHandOffResources } from './resource-transfer-coordinator';

/** Test seams for hand_off_session. Production code uses the real spawn handler,
 * session close path, team transfer, marker transfer, and task reassignment. */
export interface HandOffSessionHandlerDeps {
  spawnSession?: typeof spawnSessionHandler;
  closeSession?: (sessionId: string) => Promise<void>;
  cwdExists?: (path: string) => boolean;
  transferResources?: typeof transferHandOffResources;
  reassignTaskOwner?: (
    oldSessionId: string,
    newSessionId: string,
    opts: { policy: 'preserve-team' },
  ) => number;
}
