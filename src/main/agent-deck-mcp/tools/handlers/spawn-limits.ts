import { sessionRepo } from '@main/store/session-repo';
import { inFlightChildren } from '../../rate-limiter';
import type { SpawnSessionLimits } from '../schemas';
import log from '@main/utils/logger';

const logger = log.scope('mcp-spawn');

export function finalizeSpawnLimits(
  base: SpawnSessionLimits,
  input: { callerSessionId: string; spawnDepth: number },
): SpawnSessionLimits {
  try {
    const activeChildren = sessionRepo.listChildren(input.callerSessionId, 'active').length;
    const inFlight = inFlightChildren.get(input.callerSessionId);
    return {
      ...base,
      depth: {
        ...base.depth,
        next: input.spawnDepth,
      },
      fanOut: {
        ...base.fanOut,
        current: activeChildren + inFlight,
        activeChildren,
        inFlight,
      },
    };
  } catch (e) {
    logger.warn(`[mcp spawn_session] spawnLimits fan-out refresh failed:`, e);
    return {
      ...base,
      depth: {
        ...base.depth,
        next: input.spawnDepth,
      },
    };
  }
}
