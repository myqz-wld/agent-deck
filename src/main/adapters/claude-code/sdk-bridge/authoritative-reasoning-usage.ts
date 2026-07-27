import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';

type EmitFn = (kind: AgentEvent['kind'], payload: unknown) => void;

export interface ClaudeResultReasoningUsage {
  uuid?: string;
  usage?: {
    output_tokens_details?: { thinking_tokens?: number | null } | null;
  };
}

function finiteNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function persistedTurnReasoning(internal: InternalSession): number {
  let total = 0;
  for (const usage of internal.turnUsageByBucket.values()) {
    total += Math.max(0, Math.trunc(usage.reasoning));
  }
  return total;
}

/**
 * Persist only provider-reported reasoning usage.
 *
 * Assistant frames may already contain an exact `thinking_tokens` detail. The result frame can
 * repeat the same turn-wide total, so only its positive remainder is emitted. A result aggregate
 * cannot be split exactly across multiple models; keep the exact total under the session fallback
 * model instead of manufacturing a per-model allocation.
 */
export function emitAuthoritativeReasoningUsage(
  emit: EmitFn,
  internal: InternalSession,
  fallbackModel: string,
  result: ClaudeResultReasoningUsage,
): void {
  const authoritative = finiteNonNegativeInteger(
    result.usage?.output_tokens_details?.thinking_tokens,
  );
  if (authoritative === null) return;

  const remainder = Math.max(0, authoritative - persistedTurnReasoning(internal));
  if (remainder <= 0) return;
  emit('token-usage', {
    messageId: result.uuid ? `result:${result.uuid}:reasoning` : null,
    model: fallbackModel,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: remainder,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

export function resetTurnUsageAccounting(internal: InternalSession): void {
  internal.turnUsageByBucket.clear();
}
