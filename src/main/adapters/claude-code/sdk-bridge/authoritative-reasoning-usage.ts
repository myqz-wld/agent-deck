import type { InternalSession } from './types';

/** Clear obsolete per-turn provisional accounting after final result or stream teardown. */
export function resetTurnUsageAccounting(internal: InternalSession): void {
  internal.turnUsageByBucket.clear();
}
