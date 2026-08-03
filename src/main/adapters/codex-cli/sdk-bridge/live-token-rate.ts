import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { normalizeModel } from '@shared/model-normalize';
import type { CodexAppServerNotification } from '../app-server/client';
import {
  observeCodexTokenUsage,
  type CodexTokenUsageObservation,
} from '../app-server/token-usage-observation';
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
 * `tokenUsage.total` is the replay-safe cumulative watermark; its growth is the authoritative
 * output delta, with `last` used only for the first observation / older servers without totals.
 * Text deltas remain display-only and never enter the calibrated rate.
 *
 * 设计：任何异常必须吞掉（display-only，不能中断事件翻译主流程）。
 */
export function handleCodexAppServerNotificationForLiveRate(
  notification: CodexAppServerNotification,
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
  usageObservation?: CodexTokenUsageObservation,
): void {
  try {
    if (notification.method === 'turn/started') {
      armUsageState(internal, sessionId, now);
      return;
    }

    if (notification.method === 'thread/tokenUsage/updated') {
      const observation =
        usageObservation
        ?? observeCodexTokenUsage(
          notification.params,
          internal.codexTokenUsageWatermark,
          codexUsageMessageNamespace(internal),
        );
      if (!usageObservation && observation.watermark) {
        internal.codexTokenUsageWatermark = observation.watermark;
      }
      emitAppServerUsageTick(observation, internal, sessionId, now);
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

export function observeCodexNotificationUsage(
  notification: CodexAppServerNotification,
  internal: InternalSession,
): CodexTokenUsageObservation | undefined {
  if (notification.method !== 'thread/tokenUsage/updated') return undefined;
  const observation = observeCodexTokenUsage(
    notification.params,
    internal.codexTokenUsageWatermark,
    codexUsageMessageNamespace(internal),
  );
  if (observation.watermark) internal.codexTokenUsageWatermark = observation.watermark;
  return observation;
}

function codexUsageMessageNamespace(internal: InternalSession): string {
  // `applicationSid` survives a missing-jsonl fallback while `threadId` changes to the new native
  // thread. Fingerprinting by the native id prevents equal cumulative tuples from colliding across
  // those two independent provider threads.
  return internal.threadId ?? internal.applicationSid;
}

function emitAppServerUsageTick(
  observation: CodexTokenUsageObservation,
  internal: InternalSession,
  sessionId: string,
  now: number,
): void {
  const state = internal.codexLiveTokenEstimate;
  if (!state) return;
  const delta = observation.delta;
  if (!delta) return;
  const previousTickTs = state.lastUsageTickTs;
  // Every authoritative usage notification is a model/compaction boundary. Advancing the anchor
  // on a zero-delta snapshot prevents later decode rate from including compaction/tool idle time.
  state.lastUsageTickTs = now;
  // Codex reports reasoningOutputTokens as a subset of outputTokens. Use the provider total
  // directly so the display-only rate does not double-count reasoning.
  const outputTokens = delta.outputTokens ?? 0;
  if (outputTokens <= 0) return;
  const elapsedMs = Math.max(now - previousTickTs, THROTTLE_MS);
  emitLiveTick(internal, sessionId, state, outputTokens / (elapsedMs / 1000), now);
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
