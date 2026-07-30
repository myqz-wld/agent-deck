import {
  TOKEN_USAGE_METRIC,
  type AgentEventKind,
} from '@shared/types';

type AnyRecord = Record<string, unknown>;
type EmitFn = (kind: AgentEventKind, payload: unknown) => void;

export function translateCodexTokenUsage(
  params: unknown,
  emit: EmitFn,
  opts?: { model?: string | null },
): void {
  const usage = asRecord(asRecord(params)?.tokenUsage);
  const last = asRecord(usage?.last);
  const usedTokens = numberField(last?.totalTokens);
  const windowTokens = positiveNumberField(usage?.modelContextWindow);
  if (usedTokens !== null || windowTokens !== null) {
    emit('context-usage', {
      ...(usedTokens !== null ? { usedTokens } : {}),
      ...(windowTokens !== null ? { windowTokens } : {}),
    });
  }
  if (!last) return;
  const totalTokens = usedTokens;
  const inputTokens = numberField(last.inputTokens);
  const outputTokens = numberField(last.outputTokens);
  const reasoningTokens = numberField(last.reasoningOutputTokens);
  const cacheReadTokens = numberField(last.cachedInputTokens);
  const cacheCreationTokens = numberField(last.cacheWriteInputTokens);
  const reportedScope =
    metricBit(totalTokens, TOKEN_USAGE_METRIC.total) |
    metricBit(inputTokens, TOKEN_USAGE_METRIC.input) |
    metricBit(outputTokens, TOKEN_USAGE_METRIC.output) |
    metricBit(reasoningTokens, TOKEN_USAGE_METRIC.reasoning) |
    metricBit(cacheReadTokens, TOKEN_USAGE_METRIC.cacheRead) |
    metricBit(cacheCreationTokens, TOKEN_USAGE_METRIC.cacheCreation);
  // app-server can emit an empty `last` object while initializing/resuming accounting. It carries
  // no additive fact and must not make the whole bucket/day unknown.
  if (reportedScope === 0) return;
  emit('token-usage', {
    messageId: null,
    model: opts?.model ?? null,
    totalTokens,
    inputTokens,
    // Codex outputTokens is the provider's total output count; reasoningOutputTokens is a
    // breakdown within that total, not an additional count.
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    // A missing per-delta metric is not part of that additive observation. Keep total applicable
    // whenever any usage was reported so Provider total remains strict across partial rows.
    metricScope: reportedScope | TOKEN_USAGE_METRIC.total,
  });
}

function metricBit(value: number | null, bit: number): number {
  return value === null ? 0 : bit;
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function positiveNumberField(value: unknown): number | null {
  const parsed = numberField(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}
