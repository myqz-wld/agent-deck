import type { AgentEvent, GrokUsageWatermark } from '@shared/types';

import {
  explicitGrokExtensionTimestampMs,
  grokExtensionTimestampMs,
  type GrokExtensionNotification,
} from './extension';
import type { GrokTranslationState } from './translation-types';
import {
  addPartialUsageToCumulative,
  cloneWatermark,
  excludeCoveredFrontierMetrics,
  hasPositiveWatermarkValue,
  mergeWatermarks,
  payloadWatermark,
  usageDelta,
  watermarkPositiveDelta,
} from './usage-watermark';

const OVERLAPPING_LATE_MATCH_WINDOW_MS = 10 * 60 * 1000;
const ZERO_OVERLAP_LATE_MATCH_WINDOW_MS = 30 * 1000;
const MAX_REMEMBERED_USAGE_TURNS = 512;

export interface LateGrokStandardUsageMatch {
  event: AgentEvent;
  index: number;
  overlap: number;
  distanceMs: number;
}

export function findLateGrokStandardUsage(
  state: GrokTranslationState,
  extension: GrokUsageWatermark,
  notification: GrokExtensionNotification,
  model: string | null,
): LateGrokStandardUsageMatch | null {
  const extensionTs = grokExtensionTimestampMs(notification);
  let bestOverlapping: LateGrokStandardUsageMatch | null = null;
  const zeroOverlap: LateGrokStandardUsageMatch[] = [];
  for (let index = 0; index < state.uncorrelatedStandardUsage.length; index += 1) {
    const event = state.uncorrelatedStandardUsage[index];
    if (!modelsCompatible(model, eventModel(event))) continue;
    const distance = Math.abs(event.ts - extensionTs);
    const quality = usageMatchQuality(payloadWatermark(event.payload), extension);
    if (quality.contradiction) continue;
    const windowMs =
      quality.overlap > 0
        ? OVERLAPPING_LATE_MATCH_WINDOW_MS
        : ZERO_OVERLAP_LATE_MATCH_WINDOW_MS;
    if (distance > windowMs) continue;
    const candidate = { event, index, overlap: quality.overlap, distanceMs: distance };
    if (quality.overlap === 0) {
      zeroOverlap.push(candidate);
      continue;
    }
    if (!bestOverlapping || distance < bestOverlapping.distanceMs) {
      bestOverlapping = candidate;
    }
  }
  if (bestOverlapping) return bestOverlapping;
  // Optional-only corrections have no shared metric identity. Never guess between two nearby
  // standard fallbacks; history import can retain them as separate exact provider rows.
  return zeroOverlap.length === 1 ? zeroOverlap[0] ?? null : null;
}

export function isExplicitlyOlderThanCurrentGrokTurn(
  state: GrokTranslationState,
  notification: GrokExtensionNotification,
): boolean {
  const explicitTs = explicitGrokExtensionTimestampMs(notification);
  return (
    explicitTs !== null &&
    state.currentTurnStartedAt !== null &&
    explicitTs < state.currentTurnStartedAt
  );
}

export function shouldApplyToCompletedGrokTurn(
  state: GrokTranslationState,
  messageId: string,
  candidate: LateGrokStandardUsageMatch,
  notification: GrokExtensionNotification,
): boolean {
  if (messageId === state.currentProviderPromptId) return false;
  if (state.currentTurnUsageId === null) return true;
  const explicitlyOlder = isExplicitlyOlderThanCurrentGrokTurn(state, notification);
  // A shared exact metric is a strong correlation signal, but do not let a stale fallback from
  // many minutes ago steal a same-shaped extension from the active turn. Adjacent-turn delivery
  // remains deterministic; older rows are left for history reconciliation.
  if (candidate.overlap > 0) {
    return explicitlyOlder || candidate.distanceMs <= ZERO_OVERLAP_LATE_MATCH_WINDOW_MS;
  }
  // Optional-only extensions have no shared metric. While another turn is active, use them as a
  // prior correction only when the provider supplied a timestamp before the current turn began.
  return explicitlyOlder;
}

export function consumeLateGrokStandardUsage(
  state: GrokTranslationState,
  candidate: LateGrokStandardUsageMatch,
): AgentEvent {
  return state.uncorrelatedStandardUsage.splice(candidate.index, 1)[0] ?? candidate.event;
}

export function rememberCompletedGrokPromptId(
  state: GrokTranslationState,
  messageId: string | null,
): void {
  if (!messageId) return;
  state.completedProviderPromptIds.delete(messageId);
  state.completedProviderPromptIds.add(messageId);
  while (state.completedProviderPromptIds.size > MAX_REMEMBERED_USAGE_TURNS) {
    const oldest = state.completedProviderPromptIds.values().next().value as string | undefined;
    if (!oldest) return;
    state.completedProviderPromptIds.delete(oldest);
  }
}

export function rememberCanonicalGrokUsage(
  state: GrokTranslationState,
  messageId: string,
  usage: GrokUsageWatermark,
  baselineTracked?: boolean,
  frontierCoveredMetricScope?: number,
): void {
  state.canonicalUsageByPromptId.delete(messageId);
  state.canonicalUsageByPromptId.set(messageId, { ...usage });
  if (baselineTracked === true) state.baselineTrackedPromptIds.add(messageId);
  if (frontierCoveredMetricScope !== undefined) {
    state.frontierCoveredMetricScopeByPromptId.delete(messageId);
    state.frontierCoveredMetricScopeByPromptId.set(
      messageId,
      frontierCoveredMetricScope,
    );
  }
  while (state.canonicalUsageByPromptId.size > MAX_REMEMBERED_USAGE_TURNS) {
    const oldest = state.canonicalUsageByPromptId.keys().next().value as string | undefined;
    if (!oldest) return;
    state.canonicalUsageByPromptId.delete(oldest);
    state.baselineTrackedPromptIds.delete(oldest);
    state.frontierCoveredMetricScopeByPromptId.delete(oldest);
  }
}

/**
 * Apply only the newly discovered portion of a completed turn to the cumulative frontier.
 * While a later turn has an uncommitted ACP snapshot, persist its corrected turn-start baseline
 * and mutate that retained event in place; never expose the in-flight snapshot early.
 */
export function advanceCompletedGrokUsageFrontier(
  state: GrokTranslationState,
  previousCanonical: GrokUsageWatermark,
  nextCanonical: GrokUsageWatermark,
  frontierCoveredMetricScope = 0,
): GrokUsageWatermark | null {
  const adjustment = excludeCoveredFrontierMetrics(
    watermarkPositiveDelta(nextCanonical, previousCanonical),
    frontierCoveredMetricScope,
  );
  if (!hasPositiveWatermarkValue(adjustment)) return null;

  if (state.currentTurnUsageId === null) {
    state.lastUsage = addPartialUsageToCumulative(state.lastUsage, adjustment);
    state.turnStartUsage = cloneWatermark(state.lastUsage);
    return cloneWatermark(state.lastUsage);
  }

  const safeTurnStart = addPartialUsageToCumulative(
    state.turnStartUsage,
    adjustment,
  );
  state.turnStartUsage = safeTurnStart;

  if (state.standardUsageObservedForCurrentTurn) {
    state.lastUsage = mergeWatermarks(state.lastUsage, safeTurnStart);
    recomputeCurrentStandardUsageEvent(state);
    return cloneWatermark(safeTurnStart);
  }

  if (state.extensionUsageForCurrentTurn) {
    // The current extension row has already committed its own frontier; adding the historical
    // correction here is safe and keeps the combined frontier monotonic.
    state.lastUsage = addPartialUsageToCumulative(state.lastUsage, adjustment);
    return cloneWatermark(state.lastUsage);
  }

  state.lastUsage = cloneWatermark(safeTurnStart);
  return cloneWatermark(safeTurnStart);
}

function usageMatchQuality(
  standard: GrokUsageWatermark,
  extension: GrokUsageWatermark,
): { contradiction: boolean; overlap: number } {
  const keys = Object.keys(standard) as Array<keyof GrokUsageWatermark>;
  let overlap = 0;
  for (const key of keys) {
    const a = standard[key];
    const b = extension[key];
    if (a === null || b === null) continue;
    if (a !== b) return { contradiction: true, overlap };
    overlap += 1;
  }
  return { contradiction: false, overlap };
}

function recomputeCurrentStandardUsageEvent(state: GrokTranslationState): void {
  const event = state.currentStandardUsageEvent;
  const snapshot = state.currentStandardUsageSnapshot;
  if (!event || !snapshot) return;
  const payload = event.payload as Record<string, unknown>;
  const previous = state.turnStartUsage;
  const firstSnapshot = previous === null;
  payload.totalTokens = usageDelta(
    snapshot.totalTokens,
    previous?.totalTokens,
    firstSnapshot,
  );
  payload.inputTokens = usageDelta(
    snapshot.inputTokens,
    previous?.inputTokens,
    firstSnapshot,
  );
  payload.outputTokens = usageDelta(
    snapshot.outputTokens,
    previous?.outputTokens,
    firstSnapshot,
  );
  payload.reasoningTokens = usageDelta(
    snapshot.thoughtTokens,
    previous?.thoughtTokens,
    firstSnapshot,
  );
  payload.cacheReadTokens = usageDelta(
    snapshot.cachedReadTokens,
    previous?.cachedReadTokens,
    firstSnapshot,
  );
  payload.cacheCreationTokens = usageDelta(
    snapshot.cachedWriteTokens,
    previous?.cachedWriteTokens,
    firstSnapshot,
  );
  payload.grokUsageWatermark = state.lastUsage;
}

function eventModel(event: AgentEvent): string | null {
  const payload =
    event.payload !== null && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  return typeof payload.model === 'string' && payload.model.trim()
    ? payload.model.trim()
    : null;
}

function modelsCompatible(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return left.trim() === right.trim();
}
