import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { normalizeModel } from '@shared/model-normalize';
import type { ThreadEvent } from '@openai/codex-sdk';
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
    estTokensSinceFlush: 0,
    lastFlushTs: now,
    emaTps: undefined,
    itemTextLens: new Map(),
  };
  internal.codexLiveTokenEstimate = state;
  return state;
}

/**
 * 每条 Codex ThreadEvent 进 translate 前先过本函数，维护生成中 tok/s 展示态。
 *
 * - item.updated{agent_message/reasoning}：text 是累积全文，取差值算本次增量，EMA 平滑后
 *   节流 250ms emit token-rate-tick。
 * - turn.completed / turn.failed：清掉估算状态（emit done:true tick）。
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
    if (ev.type === 'item.updated') {
      const item = ev.item;
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
        sessionId: internal.applicationSid,
        bucketKey: state.bucketKey,
        tps: emaTps,
        ts: now,
      });
      return;
    }

    if (ev.type === 'turn.completed' || ev.type === 'turn.failed') {
      clearCodexLiveTokenEstimate(internal, sessionId, now);
    }
  } catch {
    // Display-only estimation must never interrupt event translation.
  }
}

/** Turn 结束 / 用户中断时清掉生成中展示态，emit done:true 让 renderer 移除该 session 的 live 条目。 */
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
