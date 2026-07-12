import type { AgentEvent, SummaryRecord } from '@shared/types';
import { mergeSessionEvents } from './session-store-events';

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
  next.set(toId, existing ? [...value, ...existing].sort((a, b) => b.ts - a.ts) : value);
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
  next.set(toId, existing && existing.ts >= value.ts ? existing : value);
  return next;
}
