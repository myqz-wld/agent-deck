import type { LogsRef } from '@shared/types';

const MAX_SCOPES = 32;
const MAX_NOTE_LENGTH = 2000;

/**
 * Merge a newly appended log pointer into the parent issue.
 * Incoming values take precedence, while time ranges expand and scopes deduplicate.
 */
export function mergeIssueLogsRef(
  existing: LogsRef | null,
  incoming: LogsRef,
  appendedAtMs: number,
): LogsRef {
  const merged: LogsRef = { date: incoming.date };
  if (incoming.tsRange && existing?.tsRange) {
    merged.tsRange = {
      start: Math.min(incoming.tsRange.start, existing.tsRange.start),
      end: Math.max(incoming.tsRange.end, existing.tsRange.end),
    };
  } else if (incoming.tsRange) {
    merged.tsRange = { ...incoming.tsRange };
  } else if (existing?.tsRange) {
    merged.tsRange = { ...existing.tsRange };
  }

  const scopes = [...new Set([...(incoming.scopes ?? []), ...(existing?.scopes ?? [])])];
  if (scopes.length > 0) merged.scopes = scopes.slice(0, MAX_SCOPES);

  if (incoming.note != null) {
    const segment = `(appended ${new Date(appendedAtMs).toISOString()}) ${incoming.note}`;
    let note = existing?.note != null ? `${existing.note}\n${segment}` : segment;
    if (note.length > MAX_NOTE_LENGTH) {
      note = `...${note.slice(note.length - (MAX_NOTE_LENGTH - 3))}`;
    }
    merged.note = note;
  } else if (existing?.note != null) {
    merged.note = existing.note;
  }
  return merged;
}
