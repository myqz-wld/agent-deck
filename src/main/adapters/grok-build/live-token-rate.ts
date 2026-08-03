import { eventBus } from '@main/event-bus';
import { normalizeModel } from '@shared/model-normalize';

const THROTTLE_MS = 250;
const EMA_ALPHA = 0.4;

export interface GrokLiveRateOwner {
  liveRate: GrokLiveRateState | null;
}

export interface GrokLiveRateState {
  sessionId: string;
  bucketKey: string;
  estTokensSinceFlush: number;
  lastFlushTs: number;
  hasFlushAnchor: boolean;
  emaTps?: number;
  firstTextTs?: number;
  lastTextTs?: number;
}

export function beginGrokLiveTokenRate(
  owner: GrokLiveRateOwner,
  sessionId: string,
  model: string | null,
  now = Date.now(),
): void {
  owner.liveRate = {
    sessionId,
    bucketKey: normalizeModel(model).bucketKey,
    estTokensSinceFlush: 0,
    lastFlushTs: now,
    hasFlushAnchor: false,
  };
}

export function handleGrokTextForLiveRate(
  owner: GrokLiveRateOwner,
  text: string,
  now = Date.now(),
): void {
  const state = owner.liveRate;
  if (!state || !text) return;
  state.firstTextTs ??= now;
  state.lastTextTs = now;

  if (!state.hasFlushAnchor) {
    state.hasFlushAnchor = true;
    state.lastFlushTs = now;
    // This chunk was generated before its callback timestamp. Counting it against time after the
    // callback creates an artificial first live spike, so start estimation with the next chunk.
    state.estTokensSinceFlush = 0;
    return;
  }
  state.estTokensSinceFlush += estimateGrokTokensFromText(text);
  const elapsedMs = now - state.lastFlushTs;
  if (elapsedMs < THROTTLE_MS) return;
  const elapsedSec = elapsedMs / 1000;
  const rawTps = elapsedSec > 0 ? state.estTokensSinceFlush / elapsedSec : 0;
  if (!Number.isFinite(rawTps) || rawTps <= 0) return;
  const tps =
    state.emaTps === undefined
      ? rawTps
      : EMA_ALPHA * rawTps + (1 - EMA_ALPHA) * state.emaTps;
  state.estTokensSinceFlush = 0;
  state.lastFlushTs = now;
  state.emaTps = tps;
  eventBus.emit('token-rate-tick', {
    sessionId: state.sessionId,
    bucketKey: state.bucketKey,
    tps,
    ts: now,
  });
}

export function completeGrokLiveTokenRate(
  owner: GrokLiveRateOwner,
  outputTokens: number,
  now = Date.now(),
  durationMs?: number,
): boolean {
  const state = owner.liveRate;
  if (!state) return false;
  owner.liveRate = null;
  const first = state.firstTextTs;
  const last = state.lastTextTs;
  const streamElapsedMs =
    first !== undefined && last !== undefined && last > first ? last - first : 0;
  const elapsedMs =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : streamElapsedMs;
  if (!Number.isFinite(outputTokens) || outputTokens <= 0 || elapsedMs <= 0) {
    eventBus.emit('token-rate-tick', {
      sessionId: state.sessionId,
      bucketKey: state.bucketKey,
      tps: 0,
      ts: now,
      done: true,
    });
    return false;
  }
  const tps = outputTokens / (elapsedMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return false;
  eventBus.emit('token-rate-tick', {
    sessionId: state.sessionId,
    bucketKey: state.bucketKey,
    tps,
    ts: now,
  });
  return true;
}

export function clearGrokLiveTokenRate(owner: GrokLiveRateOwner, now = Date.now()): void {
  const state = owner.liveRate;
  owner.liveRate = null;
  if (!state) return;
  eventBus.emit('token-rate-tick', {
    sessionId: state.sessionId,
    bucketKey: state.bucketKey,
    tps: 0,
    ts: now,
    done: true,
  });
}

export function estimateGrokTokensFromText(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const cjkChars = cjkMatches?.length ?? 0;
  const nonCjkText = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, '');
  const nonCjkChars = nonCjkText.replace(/\s+/g, '').length;
  return cjkChars / 1.7 + nonCjkChars / 4;
}
