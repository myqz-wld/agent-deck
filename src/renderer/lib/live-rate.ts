import type { TokenRateRow } from '@shared/types';

export const LIVE_STALE_MS = 1500;

export interface LiveRateEntry {
  bucketKey: string;
  tps: number;
  updatedAt: number;
}

export function buildFreshLiveByBucket(
  liveBySession: Record<string, LiveRateEntry>,
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of Object.values(liveBySession)) {
    if (now - entry.updatedAt > LIVE_STALE_MS) continue;
    out.set(entry.bucketKey, (out.get(entry.bucketKey) ?? 0) + entry.tps);
  }
  return out;
}

export function rankLiveAwareBuckets(
  freshLiveByBucket: Map<string, number>,
  pollRows: TokenRateRow[],
): string[] {
  const pollOutputByBucket = new Map(pollRows.map((row) => [row.bucketKey, row.outputTokens]));
  const bucketKeys = new Set<string>([
    ...freshLiveByBucket.keys(),
    ...pollRows.map((row) => row.bucketKey),
  ]);

  return [...bucketKeys].sort((a, b) => {
    const liveA = freshLiveByBucket.get(a) ?? 0;
    const liveB = freshLiveByBucket.get(b) ?? 0;
    const hasLiveA = liveA > 0 ? 1 : 0;
    const hasLiveB = liveB > 0 ? 1 : 0;
    if (hasLiveA !== hasLiveB) return hasLiveB - hasLiveA;
    if (liveA !== liveB) return liveB - liveA;
    const pollA = pollOutputByBucket.get(a) ?? 0;
    const pollB = pollOutputByBucket.get(b) ?? 0;
    if (pollA !== pollB) return pollB - pollA;
    return a.localeCompare(b);
  });
}
