import {
  TOKEN_USAGE_METRIC,
  type AgentEventKind,
  type ContextRuntimeIdentityEvidence,
} from '@shared/types';
import {
  observeCodexTokenUsage,
  type CodexTokenUsageObservation,
} from './token-usage-observation';

type AnyRecord = Record<string, unknown>;
type EmitFn = (kind: AgentEventKind, payload: unknown) => void;

export function translateCodexTokenUsage(
  params: unknown,
  emit: EmitFn,
  opts?: {
    emitTokenUsage?: boolean;
    model?: string | null;
    observation?: CodexTokenUsageObservation;
    runtimeIdentity?: ContextRuntimeIdentityEvidence | null;
  },
): void {
  const observation = opts?.observation ?? observeCodexTokenUsage(params);
  const usedTokens = observation.contextUsedTokens;
  const windowTokens = observation.contextWindowTokens;
  if (usedTokens !== null || windowTokens !== null) {
    emit('context-usage', {
      ...(usedTokens !== null ? { usedTokens } : {}),
      ...(windowTokens !== null ? { windowTokens } : {}),
      ...(opts?.runtimeIdentity
        ? { runtimeIdentity: { ...opts.runtimeIdentity } }
        : {}),
      ...(windowTokens !== null && opts?.runtimeIdentity
        ? { capacitySource: 'runtime-usage' }
        : {}),
    });
  }

  if (opts?.emitTokenUsage === false) return;

  const delta = observation.delta;
  if (!delta || !hasPositiveMetric(delta)) return;
  const totalTokens = delta.totalTokens;
  const inputTokens = delta.inputTokens;
  const outputTokens = delta.outputTokens;
  const reasoningTokens = delta.reasoningOutputTokens;
  const cacheReadTokens = delta.cachedInputTokens;
  const cacheCreationTokens = delta.cacheWriteInputTokens;
  const reportedScope =
    metricBit(totalTokens, TOKEN_USAGE_METRIC.total) |
    metricBit(inputTokens, TOKEN_USAGE_METRIC.input) |
    metricBit(outputTokens, TOKEN_USAGE_METRIC.output) |
    metricBit(reasoningTokens, TOKEN_USAGE_METRIC.reasoning) |
    metricBit(cacheReadTokens, TOKEN_USAGE_METRIC.cacheRead) |
    metricBit(cacheCreationTokens, TOKEN_USAGE_METRIC.cacheCreation);
  emit('token-usage', {
    messageId: observation.messageId,
    model: opts?.model ?? null,
    totalTokens,
    inputTokens,
    // Codex outputTokens includes reasoningOutputTokens; reasoning is a breakdown, not additive.
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    // Preserve the existing strict Provider-total contract when a partial provider delta omits it.
    metricScope: reportedScope | TOKEN_USAGE_METRIC.total,
  });
}

export function readCodexContextWindowTokens(params: unknown): number | null {
  return positiveNumberField(asRecord(asRecord(params)?.tokenUsage)?.modelContextWindow);
}

function metricBit(value: number | null, bit: number): number {
  return value === null ? 0 : bit;
}

function hasPositiveMetric(delta: {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
}): boolean {
  return [
    delta.totalTokens,
    delta.inputTokens,
    delta.outputTokens,
    delta.reasoningOutputTokens,
    delta.cachedInputTokens,
    delta.cacheWriteInputTokens,
  ].some((value) => (value ?? 0) > 0);
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
