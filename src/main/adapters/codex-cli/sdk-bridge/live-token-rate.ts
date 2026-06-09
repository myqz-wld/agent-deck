import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { normalizeModel } from '@shared/model-normalize';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { CodexAppServerNotification } from '../app-server/client';
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

function ingestDeltaText(
  internal: InternalSession,
  sessionId: string,
  deltaText: string,
  now: number,
): void {
  if (!deltaText) return;
  const state = internal.codexLiveTokenEstimate ?? armEstimate(internal, sessionId, now);
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

export function handleCodexAppServerNotificationForLiveRate(
  notification: CodexAppServerNotification,
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
): void {
  try {
    if (notification.method === 'turn/started') {
      armEstimate(internal, sessionId, now);
      return;
    }

    if (
      notification.method === 'item/agentMessage/delta' ||
      notification.method === 'item/reasoning/textDelta' ||
      notification.method === 'item/reasoning/summaryTextDelta'
    ) {
      const delta = readStringField(notification.params, 'delta');
      ingestDeltaText(internal, sessionId, delta, now);
      return;
    }

    if (notification.method === 'item/completed') {
      ingestAppServerCompletedText(notification.params, internal, sessionId, now);
      return;
    }

    if (notification.method === 'thread/tokenUsage/updated') {
      emitAppServerUsageTick(notification.params, internal, sessionId, now);
      return;
    }

    if (notification.method === 'turn/completed') {
      clearCodexLiveTokenEstimate(internal, sessionId, now);
      return;
    }

    if (notification.method === 'error') {
      const params = notification.params as { willRetry?: unknown } | undefined;
      if (params?.willRetry !== true) clearCodexLiveTokenEstimate(internal, sessionId, now);
    }
  } catch {
    // Display-only estimation must never interrupt event translation.
  }
}

function ingestAppServerCompletedText(
  params: unknown,
  internal: InternalSession,
  sessionId: string,
  now: number,
): void {
  const item = readObjectField(params, 'item');
  if (!item) return;
  const type = item.type;
  if (type === 'agentMessage') {
    ingestDeltaText(internal, sessionId, readStringField(item, 'text'), now);
    return;
  }
  if (type === 'reasoning') {
    const content = readStringArrayField(item, 'content');
    const summary = readStringArrayField(item, 'summary');
    ingestDeltaText(
      internal,
      sessionId,
      content.length > 0 ? content.join('\n') : summary.join('\n'),
      now,
    );
  }
}

function emitAppServerUsageTick(
  params: unknown,
  internal: InternalSession,
  sessionId: string,
  now: number,
): void {
  const state = internal.codexLiveTokenEstimate;
  if (!state) return;
  const tokenUsage = readObjectField(params, 'tokenUsage');
  const last = readObjectField(tokenUsage, 'last');
  if (!last) return;
  const elapsedMs = Math.max(now - state.turnStartedTs, THROTTLE_MS);
  const outputTokens =
    readNumberField(last, 'outputTokens') + readNumberField(last, 'reasoningOutputTokens');
  emitLiveTick(internal, sessionId, state, outputTokens / (elapsedMs / 1000), now, false);
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}

function readStringField(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : '';
}

function readNumberField(value: unknown, key: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : 0;
}

function readStringArrayField(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field.filter((x): x is string => typeof x === 'string') : [];
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
