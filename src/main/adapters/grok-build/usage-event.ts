import type { AgentEvent, GrokUsageWatermark } from '@shared/types';

const AGENT_ID = 'grok-build';

export function grokUsageEvent(input: {
  sessionId: string;
  messageId: string;
  replacesMessageId?: string | null;
  model: string | null;
  usage: GrokUsageWatermark;
  watermark: GrokUsageWatermark | null;
  frontierCoveredMetricScope?: number;
  ts?: number;
  affectsCurrentTurn?: boolean;
}): AgentEvent {
  return {
    sessionId: input.sessionId,
    agentId: AGENT_ID,
    kind: 'token-usage',
    payload: {
      messageId: input.messageId,
      ...(input.replacesMessageId
        ? { replacesMessageId: input.replacesMessageId }
        : {}),
      model: input.model,
      totalTokens: input.usage.totalTokens,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      reasoningTokens: input.usage.thoughtTokens,
      cacheReadTokens: input.usage.cachedReadTokens,
      cacheCreationTokens: input.usage.cachedWriteTokens,
      ...(input.watermark ? { grokUsageWatermark: input.watermark } : {}),
      ...(input.frontierCoveredMetricScope
        ? {
            grokFrontierCoveredMetricScope:
              input.frontierCoveredMetricScope,
          }
        : {}),
      ...(input.affectsCurrentTurn === false
        ? { grokAffectsCurrentTurn: false }
        : {}),
    },
    ts: input.ts ?? Date.now(),
    source: 'sdk',
  };
}

export function grokFrontierCoveredMetricScope(
  payload: Record<string, unknown>,
): number {
  const value = payload.grokFrontierCoveredMetricScope;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}
