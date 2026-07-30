import { TOKEN_USAGE_METRIC } from '@shared/types';

export interface ReportedTokenUsageMetrics {
  totalTokens?: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** Build an applicability mask from fields the provider actually reported. */
export function reportedTokenUsageMetricScope(
  usage: ReportedTokenUsageMetrics,
  options: { requireProviderTotal?: boolean } = {},
): number {
  return (
    (options.requireProviderTotal || usage.totalTokens !== null && usage.totalTokens !== undefined
      ? TOKEN_USAGE_METRIC.total
      : 0) |
    metricBit(usage.inputTokens, TOKEN_USAGE_METRIC.input) |
    metricBit(usage.outputTokens, TOKEN_USAGE_METRIC.output) |
    metricBit(usage.reasoningTokens, TOKEN_USAGE_METRIC.reasoning) |
    metricBit(usage.cacheReadTokens, TOKEN_USAGE_METRIC.cacheRead) |
    metricBit(usage.cacheCreationTokens, TOKEN_USAGE_METRIC.cacheCreation)
  );
}

function metricBit(value: number | null | undefined, bit: number): number {
  return value === null || value === undefined ? 0 : bit;
}
