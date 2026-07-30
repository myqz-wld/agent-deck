import type { Usage } from '@agentclientprotocol/sdk';
import type { AgentEvent, GrokUsageWatermark } from '@shared/types';

import {
  firstModelUsageKey,
  grokExtensionTimestampMs,
  notificationPromptId,
  type GrokExtensionNotification,
  type GrokTurnUsage,
} from './extension';
import {
  beginGrokLiveTokenRate,
  clearGrokLiveTokenRate,
  completeGrokLiveTokenRate,
} from './live-token-rate';
import {
  grokFrontierCoveredMetricScope,
  grokUsageEvent as usageEvent,
} from './usage-event';
import {
  advanceCompletedGrokUsageFrontier,
  consumeLateGrokStandardUsage,
  findLateGrokStandardUsage,
  isExplicitlyOlderThanCurrentGrokTurn,
  rememberCanonicalGrokUsage,
  rememberCompletedGrokPromptId,
  shouldApplyToCompletedGrokTurn,
} from './usage-correlation';
import type {
  GrokTranslationState,
  PendingGrokStandardUsage,
} from './translation-types';
import {
  addPartialUsageToCumulative,
  cloneWatermark,
  cumulativeFrontierCoveredMetricScope,
  excludeCoveredFrontierMetrics,
  grokTurnUsageWatermark,
  hasPositiveWatermarkValue,
  hasWatermarkValues,
  mergePayloadUsage,
  mergeWatermarks,
  payloadWatermark,
  standardUsageWatermark,
  usageDelta,
  watermarkPositiveDelta,
  watermarksEqual,
} from './usage-watermark';

const GROK_EXTENSION_USAGE_GRACE_MS = 100;

export function beginGrokTurn(
  state: GrokTranslationState,
  sessionId: string,
  model: string | null,
  turnUsageId = `${sessionId}:${Date.now()}`,
): void {
  rememberCompletedGrokPromptId(state, state.currentExtensionPromptId);
  cancelPendingGrokStandardUsage(state);
  state.turnStartUsage = cloneWatermark(state.lastUsage);
  state.currentTurnUsageId = `grok-standard:${sessionId}:${turnUsageId}`;
  state.currentTurnStartedAt = Date.now();
  state.currentProviderPromptId = null;
  state.currentExtensionPromptId = null;
  state.currentExtensionUsage = null;
  state.currentStandardUsageEvent = null;
  state.currentStandardUsageSnapshot = null;
  state.assistantObservedForCurrentTurn = false;
  state.standardUsageObservedForCurrentTurn = false;
  state.extensionUsageForCurrentTurn = false;
  state.usageSource = 'none';
  beginGrokLiveTokenRate(state, sessionId, model);
}

export function translateGrokUsage(
  sessionId: string,
  model: string | null,
  usage: Usage | null | undefined,
  state: GrokTranslationState,
): AgentEvent | null {
  if (!usage) return null;
  const baselineReady = state.standardUsageBaselineReady;
  const previous = state.turnStartUsage;
  const observed = standardUsageWatermark(usage);
  const frontierCoveredMetricScope =
    previous === null && baselineReady
      ? 0
      : cumulativeFrontierCoveredMetricScope(observed, previous);
  // ACP standard usage is cumulative. Preserve previously known optional dimensions when a later
  // snapshot omits them, but derive this turn's delta only from fields reported in this snapshot.
  let current = mergeWatermarks(state.lastUsage, observed);
  if (!baselineReady && state.currentExtensionUsage) {
    current = mergeWatermarks(current, state.currentExtensionUsage);
  }
  state.lastUsage = current;
  state.standardUsageBaselineReady = true;
  state.standardUsageObservedForCurrentTurn = true;

  // A legacy recovered session has no durable cumulative watermark. Its first
  // standard snapshot is a baseline, not a turn delta. If an extension already supplied exact
  // fields for this turn, upsert that same canonical row with the newly durable baseline.
  if (!baselineReady) {
    if (!state.currentExtensionPromptId || !state.currentExtensionUsage) return null;
    rememberCanonicalGrokUsage(
      state,
      state.currentExtensionPromptId,
      state.currentExtensionUsage,
      true,
      frontierCoveredMetricScope,
    );
    return usageEvent({
      sessionId,
      messageId: state.currentExtensionPromptId,
      model,
      usage: state.currentExtensionUsage,
      watermark: current,
      frontierCoveredMetricScope,
    });
  }
  const standardDelta: GrokUsageWatermark = {
    totalTokens: usageDelta(
      observed.totalTokens,
      previous?.totalTokens,
      previous === null,
    ),
    inputTokens: usageDelta(
      observed.inputTokens,
      previous?.inputTokens,
      previous === null,
    ),
    outputTokens: usageDelta(
      observed.outputTokens,
      previous?.outputTokens,
      previous === null,
    ),
    thoughtTokens: usageDelta(
      observed.thoughtTokens,
      previous?.thoughtTokens,
      previous === null,
    ),
    cachedReadTokens: usageDelta(
      observed.cachedReadTokens,
      previous?.cachedReadTokens,
      previous === null,
    ),
    cachedWriteTokens: usageDelta(
      observed.cachedWriteTokens,
      previous?.cachedWriteTokens,
      previous === null,
    ),
  };
  const canonical = state.currentExtensionUsage
    ? mergeWatermarks(standardDelta, state.currentExtensionUsage)
    : standardDelta;
  const messageId =
    state.currentExtensionPromptId ??
    state.currentTurnUsageId ??
    `grok-standard:${sessionId}:unidentified`;
  const event = usageEvent({
    sessionId,
    messageId,
    model,
    usage: canonical,
    watermark: current,
    frontierCoveredMetricScope,
  });
  state.currentStandardUsageEvent = event;
  state.currentStandardUsageSnapshot = observed;
  if (state.currentExtensionPromptId) {
    rememberCanonicalGrokUsage(
      state,
      state.currentExtensionPromptId,
      canonical,
      true,
      frontierCoveredMetricScope,
    );
  }
  return event;
}

export function translateGrokTurnUsage(
  sessionId: string,
  model: string | null,
  notification: GrokExtensionNotification,
  state: GrokTranslationState,
): AgentEvent | null {
  const update = notification.update;
  if (!update || update.sessionUpdate !== 'turn_completed' || !isGrokTurnUsage(update.usage)) {
    return null;
  }
  const messageId = notificationPromptId(notification);
  if (!messageId) return null;
  const usage = update.usage;
  const resolvedModel = model?.trim() || firstModelUsageKey(usage);
  const observed = grokTurnUsageWatermark(usage);
  if (!hasWatermarkValues(observed)) return null;
  const priorObserved = state.extensionUsageByPromptId.get(messageId) ?? null;
  const mergedObserved = mergeWatermarks(priorObserved, observed);
  const hasNewUsage = !watermarksEqual(priorObserved, mergedObserved);
  state.extensionUsageByPromptId.set(messageId, mergedObserved);
  trimOldestMapEntries(state.extensionUsageByPromptId, 512);

  const isCurrentPromptHint = messageId === state.currentProviderPromptId;
  if (!isCurrentPromptHint && state.completedProviderPromptIds.has(messageId)) {
    if (!hasNewUsage) return null;
    const previousCanonical =
      state.canonicalUsageByPromptId.get(messageId) ?? priorObserved;
    const canonical = mergeWatermarks(previousCanonical, mergedObserved);
    if (watermarksEqual(previousCanonical, canonical)) return null;
    const watermark =
      previousCanonical && state.baselineTrackedPromptIds.has(messageId)
        ? advanceCompletedGrokUsageFrontier(
            state,
            previousCanonical,
            canonical,
            state.frontierCoveredMetricScopeByPromptId.get(messageId) ?? 0,
          )
        : null;
    rememberCanonicalGrokUsage(state, messageId, canonical);
    return usageEvent({
      sessionId,
      messageId,
      model: resolvedModel,
      usage: canonical,
      // The watermark, when present, is either the completed frontier or the active turn's safe
      // corrected start. It never contains an in-flight standard snapshot.
      watermark,
      ts: grokExtensionTimestampMs(notification),
      affectsCurrentTurn: false,
    });
  }

  const explicitlyOlder =
    !isCurrentPromptHint &&
    isExplicitlyOlderThanCurrentGrokTurn(state, notification);
  const lateCandidate = isCurrentPromptHint
    ? null
    : findLateGrokStandardUsage(
        state,
        mergedObserved,
        notification,
        resolvedModel,
      );
  if (
    lateCandidate &&
    (explicitlyOlder ||
      shouldApplyToCompletedGrokTurn(
        state,
        messageId,
        lateCandidate,
        notification,
      ))
  ) {
    const lateStandard = consumeLateGrokStandardUsage(state, lateCandidate);
    rememberCompletedGrokPromptId(state, messageId);
    const latePayload = lateStandard.payload as Record<string, unknown>;
    const previousCanonical = payloadWatermark(latePayload);
    const canonical = mergeWatermarks(previousCanonical, mergedObserved);
    const frontierCoveredMetricScope =
      grokFrontierCoveredMetricScope(latePayload);
    const watermark = advanceCompletedGrokUsageFrontier(
      state,
      previousCanonical,
      canonical,
      frontierCoveredMetricScope,
    );
    rememberCanonicalGrokUsage(
      state,
      messageId,
      canonical,
      true,
      frontierCoveredMetricScope,
    );
    return usageEvent({
      sessionId,
      messageId,
      replacesMessageId:
        typeof latePayload.messageId === 'string' ? latePayload.messageId : null,
      model: resolvedModel,
      usage: canonical,
      watermark,
      ts: grokExtensionTimestampMs(notification),
      affectsCurrentTurn: false,
    });
  }
  if (explicitlyOlder || state.currentTurnUsageId === null) {
    // The provider timestamp proves this cannot belong to the active turn, even when a corrected
    // shared metric makes every provisional fallback incompatible. Likewise, with no active turn,
    // an ambiguous extension is necessarily historical. Do not guess which fallback to replace or
    // how much of the cumulative frontier it represents.
    if (!hasNewUsage) return null;
    rememberCompletedGrokPromptId(state, messageId);
    const previousCanonical =
      state.canonicalUsageByPromptId.get(messageId) ?? null;
    const canonical = mergeWatermarks(previousCanonical, mergedObserved);
    rememberCanonicalGrokUsage(state, messageId, canonical);
    return usageEvent({
      sessionId,
      messageId,
      model: resolvedModel,
      usage: canonical,
      watermark: null,
      ts: grokExtensionTimestampMs(notification),
      affectsCurrentTurn: false,
    });
  }
  // Extension notifications can replay the same prompt snapshot. The first row is already exact;
  // ignore a metric-identical replay unless it was needed by the late-correlation branch above.
  if (!hasNewUsage) return null;

  state.currentExtensionPromptId = messageId;
  state.currentExtensionUsage = mergedObserved;
  state.extensionUsageForCurrentTurn = true;
  state.usageSource = 'extension';

  // The standard cumulative response is already available during the grace window. Canonicalize
  // that exact row to the provider prompt id instead of persisting a partial extension and a second
  // fallback row.
  if (state.pendingStandardUsage && state.currentStandardUsageEvent) {
    const standardPayload = state.currentStandardUsageEvent.payload as Record<string, unknown>;
    const previousCanonical = payloadWatermark(standardPayload);
    const canonical = mergePayloadUsage(standardPayload, mergedObserved);
    const frontierCoveredMetricScope =
      grokFrontierCoveredMetricScope(standardPayload);
    const correction = excludeCoveredFrontierMetrics(
      watermarkPositiveDelta(canonical, previousCanonical),
      frontierCoveredMetricScope,
    );
    if (
      state.standardUsageBaselineReady &&
      hasPositiveWatermarkValue(correction)
    ) {
      state.lastUsage = addPartialUsageToCumulative(
        state.lastUsage,
        correction,
      );
    }
    rememberCanonicalGrokUsage(
      state,
      messageId,
      canonical,
      state.standardUsageBaselineReady,
      frontierCoveredMetricScope,
    );
    cancelPendingGrokStandardUsage(state);
    return usageEvent({
      sessionId,
      messageId,
      model: resolvedModel,
      usage: canonical,
      watermark: state.lastUsage,
      ts: grokExtensionTimestampMs(notification),
    });
  }

  const retainedStandardPayload =
    state.standardUsageObservedForCurrentTurn &&
    state.currentStandardUsageEvent
      ? state.currentStandardUsageEvent.payload as Record<string, unknown>
      : null;
  const previousCanonical =
    state.canonicalUsageByPromptId.get(messageId) ??
    (retainedStandardPayload
      ? payloadWatermark(retainedStandardPayload)
      : null);
  const canonical = mergeWatermarks(previousCanonical, mergedObserved);
  const frontierCoveredMetricScope =
    state.frontierCoveredMetricScopeByPromptId.get(messageId) ??
    (retainedStandardPayload
      ? grokFrontierCoveredMetricScope(retainedStandardPayload)
      : 0);
  const correction = excludeCoveredFrontierMetrics(
    watermarkPositiveDelta(canonical, previousCanonical),
    frontierCoveredMetricScope,
  );
  if (
    state.standardUsageBaselineReady &&
    hasPositiveWatermarkValue(correction)
  ) {
    state.lastUsage = addPartialUsageToCumulative(state.lastUsage, correction);
  }
  rememberCanonicalGrokUsage(
    state,
    messageId,
    canonical,
    state.standardUsageBaselineReady,
    frontierCoveredMetricScope,
  );
  cancelPendingGrokStandardUsage(state);
  return usageEvent({
    sessionId,
    messageId,
    model: resolvedModel,
    usage: canonical,
    watermark:
      state.standardUsageBaselineReady ? state.lastUsage : null,
    ts: grokExtensionTimestampMs(notification),
  });
}

export function waitForGrokStandardUsage(
  state: GrokTranslationState,
  graceMs = GROK_EXTENSION_USAGE_GRACE_MS,
): Promise<boolean> {
  if (state.usageSource === 'extension') return Promise.resolve(false);
  if (state.pendingStandardUsage) {
    cancelPendingGrokStandardUsage(state);
  }
  return new Promise((resolve) => {
    const pending: PendingGrokStandardUsage = {
      resolve: (emit) => {
        if (state.pendingStandardUsage !== pending) return;
        state.pendingStandardUsage = null;
        clearTimeout(pending.timer);
        resolve(emit);
      },
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    pending.timer = setTimeout(() => {
      if (state.usageSource === 'extension') {
        pending.resolve(false);
        return;
      }
      pending.resolve(true);
    }, Math.max(0, graceMs));
    state.pendingStandardUsage = pending;
  });
}

export function cancelPendingGrokStandardUsage(state: GrokTranslationState): void {
  const pending = state.pendingStandardUsage;
  if (!pending) return;
  pending.resolve(false);
}

/** Call synchronously after the standard token event has committed. */
export function markGrokStandardUsageEmitted(
  state: GrokTranslationState,
  event: AgentEvent,
): void {
  state.usageSource = 'standard';
  state.uncorrelatedStandardUsage.push(event);
  if (state.uncorrelatedStandardUsage.length > 512) {
    state.uncorrelatedStandardUsage.splice(
      0,
      state.uncorrelatedStandardUsage.length - 512,
    );
  }
}

export function completeGrokTurnLiveRate(
  state: GrokTranslationState,
  outputTokens: number,
  durationMs?: number,
): void {
  completeGrokLiveTokenRate(state, outputTokens, Date.now(), durationMs);
}

export function clearGrokTurnLiveRate(state: GrokTranslationState): void {
  rememberCompletedGrokPromptId(state, state.currentExtensionPromptId);
  cancelPendingGrokStandardUsage(state);
  state.currentTurnUsageId = null;
  state.currentTurnStartedAt = null;
  state.currentProviderPromptId = null;
  state.currentExtensionPromptId = null;
  state.currentExtensionUsage = null;
  state.currentStandardUsageEvent = null;
  state.currentStandardUsageSnapshot = null;
  state.assistantObservedForCurrentTurn = false;
  clearGrokLiveTokenRate(state);
}

function isGrokTurnUsage(value: unknown): value is GrokTurnUsage {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimOldestMapEntries<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
