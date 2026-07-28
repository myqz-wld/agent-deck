import type { AgentEvent, SummaryRecord } from '@shared/types';
import { mergeSessionEvents } from './session-store-events';

export const SUMMARY_LIMIT = 50;

export function normalizeSummaries(
  summaries: readonly SummaryRecord[],
  sessionId?: string,
): SummaryRecord[] {
  const byId = new Map<number, SummaryRecord>();
  for (const summary of summaries) {
    const normalized = sessionId && summary.sessionId !== sessionId
      ? { ...summary, sessionId }
      : summary;
    const previous = byId.get(normalized.id);
    if (!previous || normalized.ts >= previous.ts) byId.set(normalized.id, normalized);
  }
  return [...byId.values()]
    .sort((left, right) => right.ts - left.ts || right.id - left.id)
    .slice(0, SUMMARY_LIMIT);
}

export function upsertSummary(
  summaries: readonly SummaryRecord[],
  summary: SummaryRecord,
): SummaryRecord[] {
  return normalizeSummaries([summary, ...summaries], summary.sessionId);
}

export function moveSessionEvents(
  src: Map<string, AgentEvent[]>,
  fromId: string,
  toId: string,
  limit: number,
): Map<string, AgentEvent[]> {
  if (!src.has(fromId)) return src;
  const next = new Map(src);
  const value = next.get(fromId)!;
  next.delete(fromId);
  const existing = next.get(toId);
  next.set(toId, existing ? mergeSessionEvents(value, existing, limit) : value);
  return next;
}

export function moveSessionSummaries(
  src: Map<string, SummaryRecord[]>,
  fromId: string,
  toId: string,
): Map<string, SummaryRecord[]> {
  if (!src.has(fromId)) return src;
  const next = new Map(src);
  const value = next.get(fromId)!;
  next.delete(fromId);
  const existing = next.get(toId);
  next.set(toId, normalizeSummaries(existing ? [...value, ...existing] : value, toId));
  return next;
}

export function moveLatestSummary(
  src: Map<string, SummaryRecord>,
  fromId: string,
  toId: string,
): Map<string, SummaryRecord> {
  if (!src.has(fromId)) return src;
  const next = new Map(src);
  const value = next.get(fromId)!;
  next.delete(fromId);
  const existing = next.get(toId);
  const latest = existing && existing.ts >= value.ts ? existing : value;
  next.set(toId, latest.sessionId === toId ? latest : { ...latest, sessionId: toId });
  return next;
}
