import type { AgentEvent } from '@shared/types';
import { compactionIdentity, compactionRecord, readCompaction, type CompactionSnapshot } from '@shared/compaction';
import { activityEventIdentity } from './viewers/activity-event-identity';

interface Group {
  key: string;
  anchor: AgentEvent;
  latest: AgentEvent;
  snapshot: CompactionSnapshot;
}

/** Collapse lifecycle events only in the view; stored provider evidence remains intact. */
export function presentCompactions(events: readonly AgentEvent[]): readonly AgentEvent[] {
  if (!events.some((event) => readCompaction(event))) return events;
  const chronological = events.map((event, index) => ({ event, index })).sort((a, b) =>
    a.event.ts - b.event.ts || storedId(a.event) - storedId(b.event) || b.index - a.index);
  const groups = new Map<string, Group>();
  const active = new Map<string, Group>();
  const running = new Map<string, Set<Group>>();
  const boundaries = new Map<string, string>();
  const membership = new Map<AgentEvent, Group>();
  for (const { event } of chronological) {
    const owner = JSON.stringify([event.sessionId, event.agentId]);
    const snapshot = readCompaction(event);
    if (!snapshot) {
      if (event.kind === 'finished' || event.kind === 'session-end' || event.kind === 'session-start') {
        for (const pending of running.get(owner) ?? []) {
          const payload = compactionRecord(event.payload);
          const interrupted = ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(String(payload.subtype));
          pending.snapshot = { ...pending.snapshot,
            status: interrupted ? 'interrupted' : payload.ok === false ? 'failed' : 'unknown',
            completedAt: event.ts,
            ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
          };
        }
        active.delete(owner);
        running.delete(owner);
        if (event.kind !== 'finished') boundaries.set(owner, activityEventIdentity(event));
      }
      continue;
    }
    const identity = compactionIdentity(event);
    const explicit = identity ? `${identity}:${boundaries.get(owner) ?? ''}` : null;
    let group = explicit ? groups.get(explicit) : active.get(owner);
    if (!group || (!explicit && snapshot.status === 'running' && event.kind === 'context-compaction-start')) {
      const key = explicit ?? `compaction:${activityEventIdentity(event)}`;
      group = { key, anchor: event, latest: event, snapshot: { ...snapshot } };
      groups.set(key, group);
    }
    const newer = snapshot.revision === undefined || group.snapshot.revision === undefined
      || snapshot.revision >= group.snapshot.revision;
    if (newer) {
      group.latest = event;
      const previous = group.snapshot;
      group.snapshot = { ...previous, ...snapshot };
      // Late chunks carry a cached native status, not new evidence that a closed turn resumed.
      if (compactionRecord(event.payload).compactionSummaryOnly === true && previous.status !== 'running') {
        group.snapshot.status = previous.status;
        group.snapshot.completedAt = previous.completedAt;
        group.snapshot.error = previous.error;
      }
    }
    if (snapshot.status === 'running' && group.snapshot.startedAt === undefined) {
      group.snapshot.startedAt = event.ts;
    }
    if (snapshot.status !== 'running' && snapshot.status !== 'unknown') {
      group.snapshot.completedAt ??= event.ts;
      if (group.snapshot.durationMs === undefined && group.snapshot.startedAt !== undefined) {
        group.snapshot.durationMs = Math.max(0, group.snapshot.completedAt - group.snapshot.startedAt);
      }
    }
    membership.set(event, group);
    if (group.snapshot.status === 'running') {
      active.set(owner, group);
      const pending = running.get(owner) ?? new Set<Group>();
      pending.add(group);
      running.set(owner, pending);
    } else {
      running.get(owner)?.delete(group);
      if (active.get(owner) === group) active.delete(owner);
    }
  }
  return events.flatMap((event) => {
    const group = membership.get(event);
    if (!group) return [event];
    if (event !== group.anchor) return [];
    return [{ ...event, payload: { ...compactionRecord(group.latest.payload),
      compaction: group.snapshot, presentationCompactionId: group.key,
    } }];
  });
}

function storedId(event: AgentEvent): number {
  const id = (event as AgentEvent & { id?: number }).id;
  return typeof id === 'number' ? id : 0;
}
