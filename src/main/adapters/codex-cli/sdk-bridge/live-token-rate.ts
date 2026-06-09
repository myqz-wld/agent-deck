import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { normalizeModel } from '@shared/model-normalize';
import type { CodexAppServerNotification } from '../app-server/client';
import type { InternalSession, CodexLiveTokenEstimateState } from './types';

const THROTTLE_MS = 250;

function resolveBucketKey(internal: InternalSession, sessionId: string): string {
  try {
    const model =
      sessionRepo.get(internal.applicationSid)?.model ?? sessionRepo.get(sessionId)?.model ?? null;
    return normalizeModel(model).bucketKey;
  } catch {
    return normalizeModel(null).bucketKey;
  }
}

function armUsageState(
  internal: InternalSession,
  sessionId: string,
  now: number,
): CodexLiveTokenEstimateState {
  const state: CodexLiveTokenEstimateState = {
    bucketKey: resolveBucketKey(internal, sessionId),
    lastUsageTickTs: now,
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
): void {
  if (!Number.isFinite(tps) || tps <= 0) return;
  state.bucketKey = resolveBucketKey(internal, sessionId);

  eventBus.emit('token-rate-tick', {
    sessionId: internal.applicationSid,
    bucketKey: state.bucketKey,
    tps,
    ts: now,
  });
}

/**
 * 每条 Codex app-server notification 进 translate 前先过本函数，维护生成中 tok/s 展示态。
 *
 * `thread/tokenUsage/updated.tokenUsage.last` 是 app-server 提供的本次 usage delta；tok/s
 * 只用该权威 delta 除以上一条权威 usage tick 到当前 tick 的耗时。文本 delta 不再参与估算，
 * 避免非权威估算污染 tok/s。
 *
 * 设计：任何异常必须吞掉（display-only，不能中断事件翻译主流程）。
 */
export function handleCodexAppServerNotificationForLiveRate(
  notification: CodexAppServerNotification,
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
): void {
  try {
    if (notification.method === 'turn/started') {
      armUsageState(internal, sessionId, now);
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
    // Display-only usage tracking must never interrupt event translation.
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
  const outputTokens =
    readNumberField(last, 'outputTokens') + readNumberField(last, 'reasoningOutputTokens');
  if (outputTokens <= 0) return;
  const elapsedMs = Math.max(now - state.lastUsageTickTs, THROTTLE_MS);
  state.lastUsageTickTs = now;
  emitLiveTick(internal, sessionId, state, outputTokens / (elapsedMs / 1000), now);
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}

function readNumberField(value: unknown, key: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : 0;
}

/** Turn 结束 / 失败 / 用户中断时清掉生成中展示态，emit done:true 让 renderer 移除该 session 的 live 条目。 */
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
