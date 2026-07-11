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
    spawnedBy: opts.spawnedBy ?? null,
    spawnDepth: opts.spawnDepth ?? 0,
  };
}

/** Materialize trusted spawn metadata on a row that an earlier SDK frame created without it. */
export function materializeInitialSpawnLink(
  sessionId: string,
  existing: SessionRecord,
  opts: UpsertOptions,
): SessionRecord {
  if (!opts.spawnedBy) return existing;

  const requestedDepth = opts.spawnDepth ?? 0;
  if (existing.spawnedBy == null) {
    if (
      existing.lifecycle !== 'active' ||
      existing.archivedAt !== null ||
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

  if (existing.spawnedBy !== opts.spawnedBy || existing.spawnDepth !== requestedDepth) {
    throw new Error(
      `Refusing to re-parent session ${sessionId} from ${existing.spawnedBy}/${existing.spawnDepth} ` +
        `to ${opts.spawnedBy}/${requestedDepth}.`,
    );
  }
  return existing;
}
