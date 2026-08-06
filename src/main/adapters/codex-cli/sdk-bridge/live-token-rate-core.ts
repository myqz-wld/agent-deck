import { normalizeModel } from '@shared/model-normalize';
import type { TokenRateTickEvent } from '@shared/types';
import {
  observeCodexTokenUsage,
  type CodexTokenUsageObservation,
  type CodexTokenUsageSnapshot,
} from '../app-server/token-usage-observation';

const THROTTLE_MS = 250;

export interface CodexLiveRateNotification {
  method: string;
  params?: unknown;
}

export interface CodexLiveTokenEstimateState {
  bucketKey: string;
  lastUsageTickTs: number;
}

export interface CodexLiveRateOwner {
  applicationSid: string;
  threadId: string | null;
  codexLiveTokenEstimate?: CodexLiveTokenEstimateState;
  codexTokenUsageWatermark?: CodexTokenUsageSnapshot;
}

export interface CodexLiveRateHost {
  resolveModel(applicationSid: string, sessionId: string): string | null;
  emitTokenRateTick(event: TokenRateTickEvent): void;
}

function resolveBucketKey(
  owner: CodexLiveRateOwner,
  sessionId: string,
  host: CodexLiveRateHost,
): string {
  try {
    return normalizeModel(host.resolveModel(owner.applicationSid, sessionId)).bucketKey;
  } catch {
    return normalizeModel(null).bucketKey;
  }
}

function armUsageState(
  owner: CodexLiveRateOwner,
  sessionId: string,
  now: number,
  host: CodexLiveRateHost,
): CodexLiveTokenEstimateState {
  const state: CodexLiveTokenEstimateState = {
    bucketKey: resolveBucketKey(owner, sessionId, host),
    lastUsageTickTs: now,
  };
  owner.codexLiveTokenEstimate = state;
  return state;
}

function emitLiveTick(
  owner: CodexLiveRateOwner,
  sessionId: string,
  state: CodexLiveTokenEstimateState,
  tps: number,
  now: number,
  host: CodexLiveRateHost,
): void {
  if (!Number.isFinite(tps) || tps <= 0) return;
  state.bucketKey = resolveBucketKey(owner, sessionId, host);
  host.emitTokenRateTick({
    sessionId: owner.applicationSid,
    bucketKey: state.bucketKey,
    tps,
    ts: now,
  });
}

/** Maintain display-only Codex tok/s state without interrupting notification translation. */
export function handleCodexNotificationForLiveRateCore(
  notification: CodexLiveRateNotification,
  owner: CodexLiveRateOwner,
  sessionId: string,
  now: number,
  host: CodexLiveRateHost,
  usageObservation?: CodexTokenUsageObservation,
): void {
  try {
    if (notification.method === 'turn/started') {
      armUsageState(owner, sessionId, now, host);
      return;
    }

    if (notification.method === 'thread/tokenUsage/updated') {
      const observation = usageObservation ?? observeCodexTokenUsage(
        notification.params,
        owner.codexTokenUsageWatermark,
        codexUsageMessageNamespace(owner),
      );
      if (!usageObservation && observation.watermark) {
        owner.codexTokenUsageWatermark = observation.watermark;
      }
      emitUsageTick(observation, owner, sessionId, now, host);
      return;
    }

    if (notification.method === 'turn/completed') {
      clearCodexLiveTokenEstimateCore(owner, sessionId, now, host);
      return;
    }

    if (notification.method === 'error') {
      const params = notification.params as { willRetry?: unknown } | undefined;
      if (params?.willRetry !== true) {
        clearCodexLiveTokenEstimateCore(owner, sessionId, now, host);
      }
    }
  } catch {
    // Display-only usage tracking must never interrupt event translation.
  }
}

export function observeCodexNotificationUsageCore(
  notification: CodexLiveRateNotification,
  owner: CodexLiveRateOwner,
): CodexTokenUsageObservation | undefined {
  if (notification.method !== 'thread/tokenUsage/updated') return undefined;
  const observation = observeCodexTokenUsage(
    notification.params,
    owner.codexTokenUsageWatermark,
    codexUsageMessageNamespace(owner),
  );
  if (observation.watermark) owner.codexTokenUsageWatermark = observation.watermark;
  return observation;
}

function codexUsageMessageNamespace(owner: CodexLiveRateOwner): string {
  return owner.threadId ?? owner.applicationSid;
}

function emitUsageTick(
  observation: CodexTokenUsageObservation,
  owner: CodexLiveRateOwner,
  sessionId: string,
  now: number,
  host: CodexLiveRateHost,
): void {
  const state = owner.codexLiveTokenEstimate;
  if (!state || !observation.delta) return;
  const previousTickTs = state.lastUsageTickTs;
  state.lastUsageTickTs = now;
  const outputTokens = observation.delta.outputTokens ?? 0;
  if (outputTokens <= 0) return;
  const elapsedMs = Math.max(now - previousTickTs, THROTTLE_MS);
  emitLiveTick(owner, sessionId, state, outputTokens / (elapsedMs / 1000), now, host);
}

export function clearCodexLiveTokenEstimateCore(
  owner: CodexLiveRateOwner,
  sessionId: string,
  now: number,
  host: CodexLiveRateHost,
): void {
  try {
    const bucketKey = owner.codexLiveTokenEstimate?.bucketKey
      ?? resolveBucketKey(owner, sessionId, host);
    owner.codexLiveTokenEstimate = undefined;
    host.emitTokenRateTick({
      sessionId: owner.applicationSid,
      bucketKey,
      tps: 0,
      ts: now,
      done: true,
    });
  } catch {
    // Same display-only isolation.
  }
}
