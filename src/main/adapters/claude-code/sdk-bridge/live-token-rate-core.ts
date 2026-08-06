import { CLAUDE_DEFAULT_BUCKET, normalizeModel } from '@shared/model-normalize';
import type { TokenRateTickEvent } from '@shared/types';

const THROTTLE_MS = 250;
const EMA_ALPHA = 0.4;

type StreamEventMessage = {
  event?: {
    type?: string;
    message?: { model?: string };
    delta?: { type?: string; text?: string; thinking?: string };
  };
};

export interface ClaudeLiveTokenEstimateState {
  bucketKey: string;
  estTokensSinceFlush: number;
  lastFlushTs: number;
  hasFlushAnchor: boolean;
  emaTps?: number;
  decodeElapsedMs: number;
  currentDecodeFirstDeltaTs?: number;
  currentDecodeLastDeltaTs?: number;
}

export interface ClaudeLiveRateOwner {
  applicationSid: string;
  liveTokenEstimate?: ClaudeLiveTokenEstimateState;
}

export interface ClaudeLiveRateHost {
  resolveModel(applicationSid: string, sessionId: string): string | null;
  emitTokenRateTick(event: TokenRateTickEvent): void;
}

function asStreamEventMessage(msg: unknown): StreamEventMessage {
  return msg && typeof msg === 'object' ? (msg as StreamEventMessage) : {};
}

function hasExplicitModel(model: string | null | undefined): model is string {
  return model != null && model.trim() !== '';
}

function resolveBucketKey(
  owner: ClaudeLiveRateOwner,
  sessionId: string,
  host: ClaudeLiveRateHost,
  modelOverride?: string | null,
): string {
  try {
    if (hasExplicitModel(modelOverride)) return normalizeModel(modelOverride).bucketKey;
    const model = host.resolveModel(owner.applicationSid, sessionId);
    if (!hasExplicitModel(model)) return CLAUDE_DEFAULT_BUCKET;
    return normalizeModel(model).bucketKey;
  } catch {
    return CLAUDE_DEFAULT_BUCKET;
  }
}

function extractDeltaText(msg: StreamEventMessage): string {
  const event = msg.event;
  if (event?.type !== 'content_block_delta' || !event.delta) return '';
  if (typeof event.delta.text === 'string') return event.delta.text;
  if (typeof event.delta.thinking === 'string') return event.delta.thinking;
  return '';
}

function extractMessageStartModel(msg: StreamEventMessage): string | null {
  const model = msg.event?.message?.model;
  return hasExplicitModel(model) ? model : null;
}

export function estimateClaudeTokensFromText(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const cjkChars = cjkMatches?.length ?? 0;
  const nonCjkText = text.replace(
    /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g,
    '',
  );
  const nonCjkChars = nonCjkText.replace(/\s+/g, '').length;
  return cjkChars / 1.7 + nonCjkChars / 4;
}

function closeCurrentDecodeSegment(state: ClaudeLiveTokenEstimateState | undefined): number {
  if (!state) return 0;
  const first = state.currentDecodeFirstDeltaTs;
  const last = state.currentDecodeLastDeltaTs;
  const elapsed = first !== undefined && last !== undefined && last > first ? last - first : 0;
  state.decodeElapsedMs += elapsed;
  state.currentDecodeFirstDeltaTs = undefined;
  state.currentDecodeLastDeltaTs = undefined;
  return elapsed;
}

function armLiveEstimate(
  owner: ClaudeLiveRateOwner,
  sessionId: string,
  now: number,
  host: ClaudeLiveRateHost,
  modelOverride?: string | null,
): void {
  const previous = owner.liveTokenEstimate;
  if (previous) closeCurrentDecodeSegment(previous);
  owner.liveTokenEstimate = {
    bucketKey: resolveBucketKey(owner, sessionId, host, modelOverride),
    estTokensSinceFlush: 0,
    lastFlushTs: now,
    hasFlushAnchor: false,
    emaTps: undefined,
    decodeElapsedMs: previous?.decodeElapsedMs ?? 0,
  };
}

function noteContentDelta(state: ClaudeLiveTokenEstimateState | undefined, now: number): void {
  if (!state) return;
  state.currentDecodeFirstDeltaTs ??= now;
  state.currentDecodeLastDeltaTs = now;
}

export function handleClaudeStreamEventForLiveRateCore(
  owner: ClaudeLiveRateOwner,
  sessionId: string,
  msg: unknown,
  now: number,
  host: ClaudeLiveRateHost,
): void {
  try {
    const streamMsg = asStreamEventMessage(msg);
    if (streamMsg.event?.type === 'message_start') {
      armLiveEstimate(owner, sessionId, now, host, extractMessageStartModel(streamMsg));
      return;
    }
    if (streamMsg.event?.type !== 'content_block_delta') return;
    if (!owner.liveTokenEstimate) armLiveEstimate(owner, sessionId, now, host);

    const state = owner.liveTokenEstimate;
    if (!state) return;
    noteContentDelta(state, now);
    const text = extractDeltaText(streamMsg);
    if (!text) return;
    state.estTokensSinceFlush += estimateClaudeTokensFromText(text);

    if (!state.hasFlushAnchor) {
      state.hasFlushAnchor = true;
      state.lastFlushTs = now;
      return;
    }
    const elapsedMs = now - state.lastFlushTs;
    if (elapsedMs < THROTTLE_MS) return;
    const rawTps = state.estTokensSinceFlush / (elapsedMs / 1000);
    if (!Number.isFinite(rawTps) || rawTps <= 0) return;

    const emaTps = state.emaTps === undefined
      ? rawTps
      : EMA_ALPHA * rawTps + (1 - EMA_ALPHA) * state.emaTps;
    state.estTokensSinceFlush = 0;
    state.lastFlushTs = now;
    state.emaTps = emaTps;
    host.emitTokenRateTick({ sessionId, bucketKey: state.bucketKey, tps: emaTps, ts: now });
  } catch {
    // Display-only estimation must never interrupt SDK message translation.
  }
}

export function completeClaudeLiveTokenEstimateCore(
  owner: ClaudeLiveRateOwner,
  sessionId: string,
  outputTokens: number,
  now: number,
  modelOverride: string | null | undefined,
  host: ClaudeLiveRateHost,
): boolean {
  try {
    const state = owner.liveTokenEstimate;
    const bucketKey = hasExplicitModel(modelOverride)
      ? resolveBucketKey(owner, sessionId, host, modelOverride)
      : state?.bucketKey ?? resolveBucketKey(owner, sessionId, host);
    if (state) closeCurrentDecodeSegment(state);
    const elapsedMs = state?.decodeElapsedMs ?? 0;
    owner.liveTokenEstimate = undefined;

    if (!Number.isFinite(outputTokens) || outputTokens <= 0 || elapsedMs <= 0) {
      host.emitTokenRateTick({ sessionId, bucketKey, tps: 0, ts: now, done: true });
      return false;
    }
    const tps = outputTokens / (elapsedMs / 1000);
    if (!Number.isFinite(tps) || tps <= 0) return false;
    host.emitTokenRateTick({ sessionId, bucketKey, tps, ts: now });
    return true;
  } catch {
    return false;
  }
}

export function clearClaudeLiveTokenEstimateCore(
  owner: ClaudeLiveRateOwner,
  sessionId: string,
  now: number,
  host: ClaudeLiveRateHost,
): void {
  try {
    const bucketKey = owner.liveTokenEstimate?.bucketKey
      ?? resolveBucketKey(owner, sessionId, host);
    owner.liveTokenEstimate = undefined;
    host.emitTokenRateTick({ sessionId, bucketKey, tps: 0, ts: now, done: true });
  } catch {
    // Same display-only isolation as live tick handling.
  }
}
