import {
  TOKEN_USAGE_ALL_METRICS,
  type AgentEventKind,
} from '@shared/types';
import type { CodexTokenUsageSnapshot } from './token-usage-observation';

type AnyRecord = Record<string, unknown>;
type EmitFn = (kind: AgentEventKind, payload: unknown) => void;

export interface CodexRawResponseUsageState {
  seenResponseIds: Set<string>;
  pendingAggregateUsages: Array<{
    responseId: string;
    usage: CodexTokenUsageSnapshot;
  }>;
}

export function createCodexRawResponseUsageState(): CodexRawResponseUsageState {
  return {
    seenResponseIds: new Set(),
    pendingAggregateUsages: [],
  };
}

/**
 * Persist the exact usage attached to one upstream Responses API completion.
 *
 * Codex emits this notification before the cumulative thread usage notification for the same
 * completion. The response id is provider-stable, so it is also the durable idempotency key.
 */
export function translateCodexRawResponseUsage(
  params: unknown,
  emit: EmitFn,
  opts: {
    model?: string | null;
    state: CodexRawResponseUsageState;
  },
): void {
  const record = asRecord(params);
  const responseId = stringField(record?.responseId);
  const usage = readExactUsage(asRecord(record?.usage));
  if (!responseId || !usage || !hasPositiveMetric(usage)) return;

  const state = opts.state;
  if (state.seenResponseIds.has(responseId)) return;
  state.seenResponseIds.add(responseId);
  state.pendingAggregateUsages.push({ responseId, usage });

  emit('token-usage', {
    messageId: `codex-response-usage-v1:${encodeURIComponent(responseId)}`,
    model: opts.model ?? null,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheWriteInputTokens,
    metricScope: TOKEN_USAGE_ALL_METRICS,
  });
}

/** Consume the cumulative echo that Codex emits after one exact raw completion usage event. */
export function consumePendingRawResponseUsage(
  state: CodexRawResponseUsageState | undefined,
  delta: CodexTokenUsageSnapshot | null,
): boolean {
  if (!state || !delta || !hasPositiveMetric(delta)) return false;
  const pending = state.pendingAggregateUsages.shift();
  return pending !== undefined && sameUsage(pending.usage, delta);
}

function readExactUsage(record: AnyRecord | null): CodexTokenUsageSnapshot | null {
  if (!record) return null;
  const usage = {
    totalTokens: numberField(record.totalTokens),
    inputTokens: numberField(record.inputTokens),
    outputTokens: numberField(record.outputTokens),
    reasoningOutputTokens: numberField(record.reasoningOutputTokens),
    cachedInputTokens: numberField(record.cachedInputTokens),
    cacheWriteInputTokens: numberField(record.cacheWriteInputTokens),
  };
  return Object.values(usage).every((value) => value !== null) ? usage : null;
}

function hasPositiveMetric(snapshot: CodexTokenUsageSnapshot): boolean {
  return Object.values(snapshot).some((value) => (value ?? 0) > 0);
}

function sameUsage(
  expected: CodexTokenUsageSnapshot,
  actual: CodexTokenUsageSnapshot,
): boolean {
  return (
    expected.totalTokens === actual.totalTokens
    && expected.inputTokens === actual.inputTokens
    && expected.outputTokens === actual.outputTokens
    && expected.reasoningOutputTokens === actual.reasoningOutputTokens
    && expected.cachedInputTokens === actual.cachedInputTokens
    && expected.cacheWriteInputTokens === actual.cacheWriteInputTokens
  );
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}
