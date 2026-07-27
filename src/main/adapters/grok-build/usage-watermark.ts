import type { Usage } from '@agentclientprotocol/sdk';
import {
  TOKEN_USAGE_METRIC,
  type GrokUsageWatermark,
} from '@shared/types';

import { finiteNumber, type GrokTurnUsage } from './extension';

export function usageValue(value: unknown): number | null {
  return finiteNumber(value);
}

export function standardUsageWatermark(usage: Usage): GrokUsageWatermark {
  return {
    totalTokens: usageValue(usage.totalTokens),
    inputTokens: usageValue(usage.inputTokens),
    outputTokens: usageValue(usage.outputTokens),
    thoughtTokens: usageValue(usage.thoughtTokens),
    cachedReadTokens: usageValue(usage.cachedReadTokens),
    cachedWriteTokens: usageValue(usage.cachedWriteTokens),
  };
}

export function grokTurnUsageWatermark(usage: GrokTurnUsage): GrokUsageWatermark {
  return {
    totalTokens: usageValue(usage.totalTokens),
    inputTokens: usageValue(usage.inputTokens),
    outputTokens: usageValue(usage.outputTokens),
    thoughtTokens: usageValue(usage.reasoningTokens ?? usage.thoughtTokens),
    cachedReadTokens: usageValue(usage.cachedReadTokens),
    cachedWriteTokens: usageValue(usage.cachedWriteTokens),
  };
}

export function cloneWatermark(
  value: GrokUsageWatermark | null,
): GrokUsageWatermark | null {
  return value ? { ...value } : null;
}

export function hasWatermarkValues(value: GrokUsageWatermark): boolean {
  return Object.values(value).some((metric) => metric !== null);
}

export function mergeWatermarks(
  previous: GrokUsageWatermark | null,
  current: GrokUsageWatermark,
): GrokUsageWatermark {
  const merge = (
    before: number | null | undefined,
    after: number | null,
  ): number | null => {
    if (before === null || before === undefined) return after;
    if (after === null) return before;
    return Math.max(before, after);
  };
  return {
    totalTokens: merge(previous?.totalTokens, current.totalTokens),
    inputTokens: merge(previous?.inputTokens, current.inputTokens),
    outputTokens: merge(previous?.outputTokens, current.outputTokens),
    thoughtTokens: merge(previous?.thoughtTokens, current.thoughtTokens),
    cachedReadTokens: merge(previous?.cachedReadTokens, current.cachedReadTokens),
    cachedWriteTokens: merge(previous?.cachedWriteTokens, current.cachedWriteTokens),
  };
}

export function watermarksEqual(
  left: GrokUsageWatermark | null,
  right: GrokUsageWatermark,
): boolean {
  if (!left) return false;
  const keys = Object.keys(right) as Array<keyof GrokUsageWatermark>;
  return keys.every((key) => left[key] === right[key]);
}

export function watermarkPositiveDelta(
  current: GrokUsageWatermark,
  previous: GrokUsageWatermark | null,
): GrokUsageWatermark {
  const delta = (
    next: number | null,
    prior: number | null | undefined,
  ): number | null => {
    if (next === null) return null;
    if (prior === null || prior === undefined) return next;
    return Math.max(0, next - prior);
  };
  return {
    totalTokens: delta(current.totalTokens, previous?.totalTokens),
    inputTokens: delta(current.inputTokens, previous?.inputTokens),
    outputTokens: delta(current.outputTokens, previous?.outputTokens),
    thoughtTokens: delta(current.thoughtTokens, previous?.thoughtTokens),
    cachedReadTokens: delta(current.cachedReadTokens, previous?.cachedReadTokens),
    cachedWriteTokens: delta(current.cachedWriteTokens, previous?.cachedWriteTokens),
  };
}

export function hasPositiveWatermarkValue(value: GrokUsageWatermark): boolean {
  return Object.values(value).some((metric) => metric !== null && metric > 0);
}

/**
 * A reported cumulative value whose persisted turn-start value is unknown is exact as a frontier
 * but cannot be attributed to the current turn. A later extension may fill the row without adding
 * that metric to the frontier again.
 */
export function cumulativeFrontierCoveredMetricScope(
  observed: GrokUsageWatermark,
  turnStart: GrokUsageWatermark | null,
): number {
  const covered = (
    current: number | null,
    previous: number | null | undefined,
    metric: number,
  ): number =>
    current !== null && (previous === null || previous === undefined) ? metric : 0;
  return (
    covered(observed.totalTokens, turnStart?.totalTokens, TOKEN_USAGE_METRIC.total) |
    covered(observed.inputTokens, turnStart?.inputTokens, TOKEN_USAGE_METRIC.input) |
    covered(observed.outputTokens, turnStart?.outputTokens, TOKEN_USAGE_METRIC.output) |
    covered(
      observed.thoughtTokens,
      turnStart?.thoughtTokens,
      TOKEN_USAGE_METRIC.reasoning,
    ) |
    covered(
      observed.cachedReadTokens,
      turnStart?.cachedReadTokens,
      TOKEN_USAGE_METRIC.cacheRead,
    ) |
    covered(
      observed.cachedWriteTokens,
      turnStart?.cachedWriteTokens,
      TOKEN_USAGE_METRIC.cacheCreation,
    )
  );
}

export function excludeCoveredFrontierMetrics(
  value: GrokUsageWatermark,
  coveredScope: number,
): GrokUsageWatermark {
  const keep = (metric: number, current: number | null): number | null =>
    (coveredScope & metric) !== 0 ? null : current;
  return {
    totalTokens: keep(TOKEN_USAGE_METRIC.total, value.totalTokens),
    inputTokens: keep(TOKEN_USAGE_METRIC.input, value.inputTokens),
    outputTokens: keep(TOKEN_USAGE_METRIC.output, value.outputTokens),
    thoughtTokens: keep(TOKEN_USAGE_METRIC.reasoning, value.thoughtTokens),
    cachedReadTokens: keep(TOKEN_USAGE_METRIC.cacheRead, value.cachedReadTokens),
    cachedWriteTokens: keep(
      TOKEN_USAGE_METRIC.cacheCreation,
      value.cachedWriteTokens,
    ),
  };
}

export function addPartialUsageToCumulative(
  previous: GrokUsageWatermark | null,
  increment: GrokUsageWatermark,
): GrokUsageWatermark {
  return {
    totalTokens: addKnown(previous?.totalTokens, increment.totalTokens),
    inputTokens: addKnown(previous?.inputTokens, increment.inputTokens),
    outputTokens: addKnown(previous?.outputTokens, increment.outputTokens),
    thoughtTokens: addKnown(previous?.thoughtTokens, increment.thoughtTokens),
    cachedReadTokens: addKnown(previous?.cachedReadTokens, increment.cachedReadTokens),
    cachedWriteTokens: addKnown(previous?.cachedWriteTokens, increment.cachedWriteTokens),
  };
}

export function usageDelta(
  current: number | null,
  previous: number | null | undefined,
  firstSnapshot: boolean,
): number | null {
  if (current === null) return null;
  if (firstSnapshot) return current;
  if (previous === null || previous === undefined || current < previous) return null;
  return current - previous;
}

export function payloadWatermark(
  payload: unknown,
): GrokUsageWatermark {
  const value =
    payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  return {
    totalTokens: usageValue(value.totalTokens),
    inputTokens: usageValue(value.inputTokens),
    outputTokens: usageValue(value.outputTokens),
    thoughtTokens: usageValue(value.reasoningTokens),
    cachedReadTokens: usageValue(value.cacheReadTokens),
    cachedWriteTokens: usageValue(value.cacheCreationTokens),
  };
}

export function mergePayloadUsage(
  payload: Record<string, unknown>,
  extension: GrokUsageWatermark,
): GrokUsageWatermark {
  return mergeWatermarks(payloadWatermark(payload), extension);
}

function addKnown(
  previous: number | null | undefined,
  increment: number | null,
): number | null {
  if (increment === null) return previous ?? null;
  if (previous === null || previous === undefined) return increment;
  return previous + increment;
}
