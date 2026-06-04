import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { normalizeModel } from '@shared/model-normalize';
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
    return normalizeModel(model).bucketKey;
  } catch {
    return normalizeModel(null).bucketKey;
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

function armLiveEstimate(internal: InternalSession, sessionId: string, now: number): void {
  internal.liveTokenEstimate = {
    bucketKey: resolveBucketKey(internal, sessionId),
    estTokensSinceFlush: 0,
    lastFlushTs: now,
    emaTps: undefined,
  };
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

    const text = extractDeltaText(streamMsg);
    if (!text) return;
    if (!internal.liveTokenEstimate) armLiveEstimate(internal, sessionId, now);

    const state = internal.liveTokenEstimate;
    if (!state) return;
    state.estTokensSinceFlush += estimateTokensFromText(text);

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
