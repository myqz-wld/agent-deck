import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionRecord } from '@shared/types';
import { deriveTitle } from '../manager-helpers';
import type { UpsertOptions } from './_deps';

export function buildInitialSessionRecord(
  sessionId: string,
  opts: UpsertOptions,
  now: number,
): SessionRecord {
  return {
    id: sessionId,
    agentId: opts.agentId,
    cwd: opts.cwd ?? '',
    title: opts.title ?? deriveTitle(opts.cwd ?? sessionId),
    source: opts.source ?? 'cli',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: now,
    lastEventAt: now,
    endedAt: null,
    archivedAt: null,
    hiddenFromHistory: opts.hiddenFromHistory === true,
    spawnedBy: opts.spawnedBy ?? null,
    spawnDepth: opts.spawnDepth ?? 0,
  };
}

/** Materialize trusted spawn metadata on a row that an earlier SDK frame created without it. */
export function materializeInitialRegistration(
  sessionId: string,
  existing: SessionRecord,
  opts: UpsertOptions,
): SessionRecord {
  let current = existing;
  if (opts.hiddenFromHistory === true && !current.hiddenFromHistory) {
    if (current.lifecycle !== 'active' || current.archivedAt !== null) {
      throw new Error(`Cannot hide non-live internal session ${sessionId} from History.`);
    }
    sessionRepo.hideFromHistory(sessionId);
    const hidden = sessionRepo.get(sessionId);
    if (!hidden) {
      throw new Error(`Session ${sessionId} disappeared while registering internal visibility.`);
    }
    current = hidden;
    eventBus.emit('session-upserted', hidden);
  }
  if (!opts.spawnedBy) return current;

  const requestedDepth = opts.spawnDepth ?? 0;
  if (current.spawnedBy == null) {
    if (
      current.lifecycle !== 'active' ||
      current.archivedAt !== null ||
      requestedDepth <= 0
    ) {
      throw new Error(`Cannot register spawn link for non-live session ${sessionId}.`);
    }
    sessionRepo.setSpawnLink(sessionId, opts.spawnedBy, requestedDepth);
    const linked = sessionRepo.get(sessionId);
    if (!linked) {
      throw new Error(`Session ${sessionId} disappeared while registering its spawn link.`);
    }
    eventBus.emit('session-upserted', linked);
    return linked;
  }

  if (current.spawnedBy !== opts.spawnedBy || current.spawnDepth !== requestedDepth) {
    throw new Error(
      `Refusing to re-parent session ${sessionId} from ${current.spawnedBy}/${current.spawnDepth} ` +
        `to ${opts.spawnedBy}/${requestedDepth}.`,
    );
  }
  return current;
}
