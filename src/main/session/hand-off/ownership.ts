import { eventBus } from '@main/event-bus';
import { handOffCutoverCoordinator } from './cutover-coordinator';
import log from '@main/utils/logger';
export { sessionOwnershipLineage, sessionOwnershipLineages, sessionOwnershipLineagesWithAliasReader } from './ownership-lineage';
export type { OwnershipAliasPageReader, OwnershipAliasProbeReader } from './ownership-lineage';

const logger = log.scope('handoff-ownership');

/**
 * Preserve an owner-bound capability across a committed handoff without rewriting its historical
 * provenance. Explicit source reactivation removes the durable alias, so the old source starts a
 * new ownership epoch and no longer grants authority to its former successor.
 */
export function isCurrentHandOffOwner(
  historicalOwnerSessionId: string | null,
  callerSessionId: string,
): boolean {
  if (!historicalOwnerSessionId) return false;
  try {
    const committedSuccessor = handOffCutoverCoordinator.successorForStrict(
      historicalOwnerSessionId,
    );
    return (committedSuccessor ?? historicalOwnerSessionId) === callerSessionId;
  } catch (error) {
    logger.warn(
      `[handoff ownership] denied unresolved owner ${historicalOwnerSessionId}`,
      error,
    );
    return false;
  }
}


/** Notify ownership-bound services after commit; listener failures cannot roll back the handoff. */
export function notifySessionHandOffCommitted(
  sourceSessionId: string,
  successorSessionId: string,
): void {
  try {
    eventBus.emit('session-hand-off-committed', { sourceSessionId, successorSessionId });
  } catch (error) {
    logger.error(
      `[handoff ownership] committed-listener failed source=${sourceSessionId} successor=${successorSessionId}`,
      error,
    );
  }
}
