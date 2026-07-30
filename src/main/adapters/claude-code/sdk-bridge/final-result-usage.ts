import { reportedTokenUsageMetricScope } from '@main/adapters/token-usage-metric-scope';
import { TOKEN_USAGE_METRIC, type AgentEvent } from '@shared/types';

const CLAUDE_UNATTRIBUTED_REASONING_MODEL = 'claude-unattributed-reasoning';

export interface ClaudeFinalResultUsage {
  uuid?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number | null } | null;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
}

/** Persist only the SDK result's finalized, field-scoped usage snapshot. */
export function emitFinalResultUsage(
  emit: (kind: AgentEvent['kind'], payload: unknown) => void,
  fallbackModel: string,
  result: ClaudeFinalResultUsage,
): void {
  try {
    const entries = Object.entries(result.modelUsage ?? {});
    if (entries.length > 0) {
      emitModelUsage(emit, result, entries);
      return;
    }
    emitAggregateUsage(emit, fallbackModel, result);
  } catch {
    // Usage accounting is side-channel telemetry and must not block result finalization.
  }
}

function emitModelUsage(
  emit: (kind: AgentEvent['kind'], payload: unknown) => void,
  result: ClaudeFinalResultUsage,
  entries: [string, NonNullable<ClaudeFinalResultUsage['modelUsage']>[string]][],
): void {
  const aggregate = result.usage;
  const aggregateReasoning = reportedUsageValue(
    aggregate?.output_tokens_details?.thinking_tokens,
  );
  const singleModel = entries.length === 1;
  for (const [model, usage] of entries) {
    // Only a single model can safely inherit an omitted aggregate dimension.
    const inputTokens = reportedUsageValue(usage.inputTokens)
      ?? (singleModel ? reportedUsageValue(aggregate?.input_tokens) : null);
    const outputTokens = reportedUsageValue(usage.outputTokens)
      ?? (singleModel ? reportedUsageValue(aggregate?.output_tokens) : null);
    const cacheReadTokens = reportedUsageValue(usage.cacheReadInputTokens)
      ?? (singleModel ? reportedUsageValue(aggregate?.cache_read_input_tokens) : null);
    const cacheCreationTokens = reportedUsageValue(usage.cacheCreationInputTokens)
      ?? (singleModel ? reportedUsageValue(aggregate?.cache_creation_input_tokens) : null);
    // Positive aggregate reasoning cannot be allocated across models; exact zero can.
    const reasoningTokens = singleModel || aggregateReasoning === 0
      ? aggregateReasoning
      : null;
    if (!hasReportedUsage([
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
    ])) continue;
    emit('token-usage', {
      messageId: result.uuid
        ? `result:${result.uuid}:model:${encodeURIComponent(model)}`
        : null,
      model,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
      metricScope: reportedTokenUsageMetricScope({
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheCreationTokens,
      }, { requireProviderTotal: true }),
    });
  }
  if (!singleModel && aggregateReasoning !== null && aggregateReasoning > 0) {
    emitUnattributedReasoningUsage(emit, result.uuid, aggregateReasoning);
  }
}

function emitAggregateUsage(
  emit: (kind: AgentEvent['kind'], payload: unknown) => void,
  fallbackModel: string,
  result: ClaudeFinalResultUsage,
): void {
  const usage = result.usage;
  if (!usage) return;
  const inputTokens = reportedUsageValue(usage.input_tokens);
  const outputTokens = reportedUsageValue(usage.output_tokens);
  const reasoningTokens = reportedUsageValue(usage.output_tokens_details?.thinking_tokens);
  const cacheReadTokens = reportedUsageValue(usage.cache_read_input_tokens);
  const cacheCreationTokens = reportedUsageValue(usage.cache_creation_input_tokens);
  if (!hasReportedUsage([
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
  ])) return;
  emit('token-usage', {
    messageId: result.uuid ? `result:${result.uuid}:aggregate` : null,
    model: fallbackModel,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    metricScope: reportedTokenUsageMetricScope({
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
    }, { requireProviderTotal: true }),
  });
}

function emitUnattributedReasoningUsage(
  emit: (kind: AgentEvent['kind'], payload: unknown) => void,
  uuid: string | undefined,
  reasoningTokens: number,
): void {
  emit('token-usage', {
    messageId: uuid ? `result:${uuid}:reasoning:unattributed` : null,
    model: CLAUDE_UNATTRIBUTED_REASONING_MODEL,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    metricScope: TOKEN_USAGE_METRIC.reasoning,
  });
}

function reportedUsageValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function hasReportedUsage(values: readonly (number | null)[]): boolean {
  return values.some((value) => value !== null);
}
