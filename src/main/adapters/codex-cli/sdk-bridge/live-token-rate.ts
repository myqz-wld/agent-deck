import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { normalizeModel } from '@shared/model-normalize';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { InternalSession, CodexLiveTokenEstimateState } from './types';

const THROTTLE_MS = 250;
const EMA_ALPHA = 0.4;

/** CJK + 非 CJK 混合文本 token 估算（与 claude-code 侧同款公式）。 */
function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[぀-ヿ㐀-鿿豈-﫿가-힯]/g);
  const cjkChars = cjkMatches?.length ?? 0;
  const nonCjkText = text.replace(/[぀-ヿ㐀-鿿豈-﫿가-힯]/g, '');
  const nonCjkChars = nonCjkText.replace(/\s+/g, '').length;
  return cjkChars / 1.7 + nonCjkChars / 4;
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

function armEstimate(
  internal: InternalSession,
  sessionId: string,
  now: number,
): CodexLiveTokenEstimateState {
  const state: CodexLiveTokenEstimateState = {
    bucketKey: resolveBucketKey(internal, sessionId),
    turnStartedTs: now,
    estTokensSinceFlush: 0,
    lastFlushTs: now,
    emaTps: undefined,
    itemTextLens: new Map(),
  };
  internal.codexLiveTokenEstimate = state;
  return state;
}

function emitLiveTick(
  internal: InternalSession,
  sessionId: string,
  state: CodexLiveTokenEstimateState,
  tps: number,
  now: number,
  smooth = true,
): void {
  if (!Number.isFinite(tps) || tps <= 0) return;
  const emaTps =
    !smooth || state.emaTps === undefined ? tps : EMA_ALPHA * tps + (1 - EMA_ALPHA) * state.emaTps;
  state.bucketKey = resolveBucketKey(internal, sessionId);
  state.estTokensSinceFlush = 0;
  state.lastFlushTs = now;
  state.emaTps = emaTps;

  eventBus.emit('token-rate-tick', {
    sessionId: internal.applicationSid,
    bucketKey: state.bucketKey,
    tps: emaTps,
    ts: now,
  });
}

function ingestCompletedOrUpdatedText(
  internal: InternalSession,
  sessionId: string,
  item: ThreadItem,
  now: number,
): void {
  if (item.type !== 'agent_message' && item.type !== 'reasoning') return;

  const text = item.text;
  if (!text) return;

  const state = internal.codexLiveTokenEstimate ?? armEstimate(internal, sessionId, now);

  const prevLen = state.itemTextLens.get(item.id) ?? 0;
  const deltaText = text.slice(prevLen);
  state.itemTextLens.set(item.id, text.length);

  if (!deltaText) return;
  state.estTokensSinceFlush += estimateTokensFromText(deltaText);

  const elapsedMs = now - state.lastFlushTs;
  if (elapsedMs < THROTTLE_MS) return;

  emitLiveTick(internal, sessionId, state, state.estTokensSinceFlush / (elapsedMs / 1000), now);
}

function emitCompletionUsageTick(
  ev: Extract<ThreadEvent, { type: 'turn.completed' }>,
  internal: InternalSession,
  sessionId: string,
  now: number,
): void {
  const state = internal.codexLiveTokenEstimate;
  if (!state) return;
  const elapsedMs = Math.max(now - state.turnStartedTs, THROTTLE_MS);
  const outputTokens = (ev.usage?.output_tokens ?? 0) + (ev.usage?.reasoning_output_tokens ?? 0);
  emitLiveTick(internal, sessionId, state, outputTokens / (elapsedMs / 1000), now, false);
  internal.codexLiveTokenEstimate = undefined;
}

/**
 * 每条 Codex ThreadEvent 进 translate 前先过本函数，维护生成中 tok/s 展示态。
 *
 * - item.updated / item.completed {agent_message/reasoning}：text 是累积全文，取差值算本次增量。
 *   当前 Codex SDK 普通回答通常只吐 item.completed，所以不能依赖 item.updated。
 * - turn.completed：用权威 usage / turn 耗时发完成态校准 tick，随后让 renderer 按 freshness
 *   自然回落到 60s token_usage 窗口。
 * - turn.failed：清掉估算状态（emit done:true tick）。
 * - 其余事件：透传不处理。
 *
 * 设计：任何异常必须吞掉（display-only，不能中断事件翻译主流程）。
 */
export function handleCodexEventForLiveRate(
  ev: ThreadEvent,
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
): void {
  try {
    if (ev.type === 'turn.started') {
      armEstimate(internal, sessionId, now);
      return;
    }

    if (ev.type === 'item.updated' || ev.type === 'item.completed') {
      ingestCompletedOrUpdatedText(internal, sessionId, ev.item, now);
      return;
    }

    if (ev.type === 'turn.completed') {
      emitCompletionUsageTick(ev, internal, sessionId, now);
      return;
    }

    if (ev.type === 'turn.failed') {
      clearCodexLiveTokenEstimate(internal, sessionId, now);
    }
  } catch {
    // Display-only estimation must never interrupt event translation.
  }
}

/** Turn 失败 / 用户中断时清掉生成中展示态，emit done:true 让 renderer 移除该 session 的 live 条目。 */
export function clearCodexLiveTokenEstimate(
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
): void {
  try {
    const bucketKey =
      internal.codexLiveTokenEstimate?.bucketKey ?? resolveBucketKey(internal, sessionId);
    internal.codexLiveTokenEstimate = undefined;
    eventBus.emit('token-rate-tick', {
      sessionId: internal.applicationSid,
      bucketKey,
      tps: 0,
      ts: now,
      done: true,
    });
  } catch {
    // Same display-only isolation.
  }
}
