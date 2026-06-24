import type { AgentEvent } from '@shared/types';
import { mergeToolUsePayload } from '@shared/agent-event-merge';

export function upsertEvent(
  arr: AgentEvent[],
  event: AgentEvent,
  limit: number,
): AgentEvent[] {
  if (event.kind === 'tool-use-start' || event.kind === 'tool-use-end') {
    const tid = (event.payload as { toolUseId?: unknown })?.toolUseId;
    if (typeof tid === 'string' && tid) {
      const normalizedEvent = withMergedToolPayload(event, null);
      const idx = arr.findIndex(
        (e) =>
          e.kind === event.kind &&
          (e.payload as { toolUseId?: unknown })?.toolUseId === tid,
      );
      if (idx >= 0) {
        const next = arr.slice();
        next[idx] = withMergedToolPayload(event, next[idx].payload);
        return next;
      }
      return [normalizedEvent, ...arr].slice(0, limit);
    }
  }
  return [event, ...arr].slice(0, limit);
}

export function dedupeRecentEvents(events: AgentEvent[], limit: number): AgentEvent[] {
  const seenStart = new Map<string, number>();
  const seenEnd = new Map<string, number>();
  const deduped: AgentEvent[] = [];
  for (const e of events) {
    if (e.kind === 'tool-use-start' || e.kind === 'tool-use-end') {
      const tid = (e.payload as { toolUseId?: unknown })?.toolUseId;
      if (typeof tid === 'string' && tid) {
        const seen = e.kind === 'tool-use-start' ? seenStart : seenEnd;
        const idx = seen.get(tid);
        if (idx != null) {
          deduped[idx] = mergeDuplicateToolEvent(deduped[idx]!, e);
          continue;
        }
        seen.set(tid, deduped.length);
        deduped.push(withMergedToolPayload(e, null));
        continue;
      }
    }
    deduped.push(e);
  }
  return deduped.slice(0, limit);
}

export function mergeSessionEvents(
  fromEvents: AgentEvent[],
  toEvents: AgentEvent[],
  limit: number,
): AgentEvent[] {
  const merged = [...fromEvents, ...toEvents].sort((e1, e2) => e2.ts - e1.ts);
  return dedupeRecentEvents(merged, limit);
}

function withMergedToolPayload(event: AgentEvent, previousPayload: unknown): AgentEvent {
  return {
    ...event,
    payload: mergeToolUsePayload(previousPayload, event.payload),
  };
}

function mergeDuplicateToolEvent(latest: AgentEvent, older: AgentEvent): AgentEvent {
  return {
    ...latest,
    payload: mergeToolUsePayload(older.payload, latest.payload),
  };
}
