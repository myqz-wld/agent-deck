import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { CLAUDE_DEFAULT_BUCKET, normalizeModel } from '@shared/model-normalize';
import type { InternalSession } from './types';

const THROTTLE_MS = 250;
const EMA_ALPHA = 0.4;

type StreamEventMessage = {
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
    };
  };
};

function asStreamEventMessage(msg: unknown): StreamEventMessage {
  return msg && typeof msg === 'object' ? (msg as StreamEventMessage) : {};
}

function resolveBucketKey(internal: InternalSession, sessionId: string): string {
  try {
    const model =
      sessionRepo.get(internal.applicationSid)?.model ?? sessionRepo.get(sessionId)?.model ?? null;
    if (model == null || model.trim() === '') return CLAUDE_DEFAULT_BUCKET;
    return normalizeModel(model).bucketKey;
  } catch {
    return CLAUDE_DEFAULT_BUCKET;
  }
}

function extractDeltaText(msg: unknown): string {
  const ev = asStreamEventMessage(msg).event;
  if (ev?.type !== 'content_block_delta') return '';
  const delta = ev.delta;
  if (!delta) return '';
  if (typeof delta.text === 'string') return delta.text;
  if (typeof delta.thinking === 'string') return delta.thinking;
  return '';
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const cjkChars = cjkMatches?.length ?? 0;
  const nonCjkText = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, '');
  const nonCjkChars = nonCjkText.replace(/\s+/g, '').length;
  return cjkChars / 1.7 + nonCjkChars / 4;
}

function closeCurrentDecodeSegment(state: InternalSession['liveTokenEstimate']): number {
  if (!state) return 0;
  const first = state.currentDecodeFirstDeltaTs;
  const last = state.currentDecodeLastDeltaTs;
  const elapsed = first !== undefined && last !== undefined && last > first ? last - first : 0;
  state.decodeElapsedMs += elapsed;
  state.currentDecodeFirstDeltaTs = undefined;
  state.currentDecodeLastDeltaTs = undefined;
  return elapsed;
}

function armLiveEstimate(internal: InternalSession, sessionId: string, now: number): void {
  const prev = internal.liveTokenEstimate;
  if (prev) closeCurrentDecodeSegment(prev);
  internal.liveTokenEstimate = {
    bucketKey: resolveBucketKey(internal, sessionId),
    estTokensSinceFlush: 0,
    lastFlushTs: now,
    hasFlushAnchor: false,
    emaTps: undefined,
    decodeElapsedMs: prev?.decodeElapsedMs ?? 0,
  };
}

function noteContentDelta(state: InternalSession['liveTokenEstimate'], now: number): void {
  if (!state) return;
  state.currentDecodeFirstDeltaTs ??= now;
  state.currentDecodeLastDeltaTs = now;
}

export function handleStreamEventForLiveRate(
  internal: InternalSession,
  sessionId: string,
  msg: unknown,
  now = Date.now(),
): void {
  try {
    const streamMsg = asStreamEventMessage(msg);
    if (streamMsg.event?.type === 'message_start') {
      armLiveEstimate(internal, sessionId, now);
      return;
    }

    if (streamMsg.event?.type !== 'content_block_delta') return;
    if (!internal.liveTokenEstimate) armLiveEstimate(internal, sessionId, now);

    const state = internal.liveTokenEstimate;
    if (!state) return;
    noteContentDelta(state, now);

    const text = extractDeltaText(streamMsg);
    if (!text) return;
    state.estTokensSinceFlush += estimateTokensFromText(text);

    if (!state.hasFlushAnchor) {
      state.hasFlushAnchor = true;
      state.lastFlushTs = now;
      return;
    }

    const elapsedMs = now - state.lastFlushTs;
    if (elapsedMs < THROTTLE_MS) return;

    const elapsedSec = elapsedMs / 1000;
    const rawTps = elapsedSec > 0 ? state.estTokensSinceFlush / elapsedSec : 0;
    if (!Number.isFinite(rawTps) || rawTps <= 0) return;

    const emaTps =
      state.emaTps === undefined ? rawTps : EMA_ALPHA * rawTps + (1 - EMA_ALPHA) * state.emaTps;
    state.bucketKey = resolveBucketKey(internal, sessionId);
    state.estTokensSinceFlush = 0;
    state.lastFlushTs = now;
    state.emaTps = emaTps;

    eventBus.emit('token-rate-tick', {
      sessionId,
      bucketKey: state.bucketKey,
      tps: emaTps,
      ts: now,
    });
  } catch {
    // Display-only estimation must never interrupt SDK message translation.
  }
}

export function completeLiveTokenEstimate(
  internal: InternalSession,
  sessionId: string,
  outputTokens: number,
  now = Date.now(),
): boolean {
  try {
    const state = internal.liveTokenEstimate;
    const bucketKey = state?.bucketKey ?? resolveBucketKey(internal, sessionId);
    if (state) closeCurrentDecodeSegment(state);

    const elapsedMs = state?.decodeElapsedMs ?? 0;
    internal.liveTokenEstimate = undefined;

    if (!Number.isFinite(outputTokens) || outputTokens <= 0 || elapsedMs <= 0) {
      eventBus.emit('token-rate-tick', {
        sessionId,
        bucketKey,
        tps: 0,
        ts: now,
        done: true,
      });
      return false;
    }

    const tps = outputTokens / (elapsedMs / 1000);
    if (!Number.isFinite(tps) || tps <= 0) return false;

    eventBus.emit('token-rate-tick', {
      sessionId,
      bucketKey,
      tps,
      ts: now,
    });
    return true;
  } catch {
    // Same display-only isolation as live tick handling.
    return false;
  }
}

export function clearLiveTokenEstimate(
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
): void {
  try {
    const bucketKey = internal.liveTokenEstimate?.bucketKey ?? resolveBucketKey(internal, sessionId);
    internal.liveTokenEstimate = undefined;
    eventBus.emit('token-rate-tick', {
      sessionId,
      bucketKey,
      tps: 0,
      ts: now,
      done: true,
    });
  } catch {
    // Same display-only isolation as live tick handling.
  }
}
