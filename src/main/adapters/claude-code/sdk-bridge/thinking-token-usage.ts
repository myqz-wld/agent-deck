import type { AgentEvent } from '@shared/types';
import { normalizeModel } from '@shared/model-normalize';
import type { InternalSession } from './types';

type EmitFn = (kind: AgentEvent['kind'], payload: unknown) => void;

interface ResultModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ClaudeResultUsageMessage {
  uuid?: string;
  usage?: {
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number | null } | null;
  };
  modelUsage?: Record<string, ResultModelUsage>;
}

interface ModelBucket {
  bucket: string;
  model: string;
  outputTokens: number;
}

interface AllocationCandidate extends ModelBucket {
  capacity: number;
  weight: number;
  allocated: number;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function finitePositiveEstimate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function persistedReasoning(internal: InternalSession, bucket: string): number {
  return Math.max(0, Math.trunc(internal.turnUsageByBucket.get(bucket)?.reasoning ?? 0));
}

function totalPersistedReasoning(internal: InternalSession): number {
  let total = 0;
  for (const usage of internal.turnUsageByBucket.values()) {
    total += Math.max(0, Math.trunc(usage.reasoning));
  }
  return total;
}

function collectModelBuckets(modelUsage: Record<string, ResultModelUsage> | undefined): ModelBucket[] {
  const byBucket = new Map<string, ModelBucket>();
  for (const [model, usage] of Object.entries(modelUsage ?? {})) {
    const bucket = normalizeModel(model).bucketKey;
    const outputTokens = finiteNonNegativeInteger(usage.outputTokens) ?? 0;
    const current = byBucket.get(bucket);
    if (current) {
      current.outputTokens += outputTokens;
    } else {
      byBucket.set(bucket, { bucket, model, outputTokens });
    }
  }
  return [...byBucket.values()];
}

function normalizedEstimates(
  internal: InternalSession,
  modelBuckets: readonly ModelBucket[],
): Map<string, number> {
  const estimates = new Map(internal.estimatedReasoningByBucket);
  if (estimates.size === 1 && modelBuckets.length === 1) {
    const [[estimateBucket, estimate]] = estimates;
    const resultBucket = modelBuckets[0].bucket;
    if (estimateBucket !== resultBucket) {
      estimates.clear();
      estimates.set(resultBucket, estimate);
    }
  }
  return estimates;
}

function reasoningMessageId(resultUuid: string | undefined, bucket: string): string | null {
  return resultUuid ? `result:${resultUuid}:${bucket}:reasoning` : null;
}

function emitReasoningOnly(
  emit: EmitFn,
  resultUuid: string | undefined,
  bucket: string,
  model: string,
  reasoningTokens: number,
): void {
  if (reasoningTokens <= 0) return;
  emit('token-usage', {
    messageId: reasoningMessageId(resultUuid, bucket),
    model,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

function allocateWeighted(
  candidates: AllocationCandidate[],
  requested: number,
  weightOf: (candidate: AllocationCandidate) => number,
): number {
  let remaining = Math.min(
    Math.max(0, Math.trunc(requested)),
    candidates.reduce(
      (sum, candidate) => sum + Math.max(0, candidate.capacity - candidate.allocated),
      0,
    ),
  );
  const initialRemaining = remaining;

  while (remaining > 0) {
    const round = candidates
      .map((candidate) => ({
        candidate,
        capacity: Math.max(0, candidate.capacity - candidate.allocated),
        weight: Math.max(0, weightOf(candidate)),
        fraction: 0,
      }))
      .filter((entry) => entry.capacity > 0 && entry.weight > 0);
    const totalWeight = round.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) break;

    const roundBudget = remaining;
    let progressed = 0;
    for (const entry of round) {
      const ideal = (roundBudget * entry.weight) / totalWeight;
      const allocation = Math.min(entry.capacity, Math.floor(ideal));
      entry.candidate.allocated += allocation;
      entry.capacity -= allocation;
      entry.fraction = ideal - Math.floor(ideal);
      progressed += allocation;
    }
    remaining -= progressed;

    const ordered = round
      .filter((entry) => entry.capacity > 0)
      .sort(
        (a, b) =>
          b.fraction - a.fraction ||
          b.capacity - a.capacity ||
          a.candidate.bucket.localeCompare(b.candidate.bucket),
      );
    for (const entry of ordered) {
      if (remaining <= 0) break;
      entry.candidate.allocated += 1;
      remaining -= 1;
      progressed += 1;
    }
    if (progressed <= 0) break;
  }

  return initialRemaining - remaining;
}

/**
 * Allocate an authoritative aggregate across real model buckets without copying the full total to
 * every model. Per-bucket estimate remainders win; unused output capacity is the fallback and cap.
 */
function allocateAggregateReasoning(
  total: number,
  internal: InternalSession,
  modelBuckets: readonly ModelBucket[],
  estimates: ReadonlyMap<string, number>,
): AllocationCandidate[] {
  const candidates: AllocationCandidate[] = modelBuckets.map((entry) => {
    const already = persistedReasoning(internal, entry.bucket);
    const estimatedTarget = Math.min(
      Math.max(0, Math.trunc(estimates.get(entry.bucket) ?? 0)),
      entry.outputTokens,
    );
    return {
      ...entry,
      capacity: Math.max(0, entry.outputTokens - already),
      weight: Math.max(0, estimatedTarget - already),
      allocated: 0,
    };
  });
  let remaining = Math.min(
    Math.max(0, Math.trunc(total)),
    candidates.reduce((sum, candidate) => sum + candidate.capacity, 0),
  );
  if (remaining <= 0) return candidates;

  const estimateBudget = Math.min(
    remaining,
    candidates.reduce((sum, candidate) => sum + candidate.weight, 0),
  );
  remaining -= allocateWeighted(candidates, estimateBudget, (candidate) => candidate.weight);
  remaining -= allocateWeighted(
    candidates,
    remaining,
    (candidate) => candidate.capacity - candidate.allocated,
  );
  return candidates;
}

export function accumulateThinkingTokenEstimate(
  internal: InternalSession,
  fallbackModel: string,
  msg: Record<string, unknown>,
): void {
  try {
    const delta = finitePositiveEstimate(msg.estimated_tokens_delta);
    if (delta === null) return;
    const messageId = typeof msg.uuid === 'string' && msg.uuid.trim() ? msg.uuid : null;
    if (messageId && internal.seenThinkingTokenMessageIds.has(messageId)) return;
    if (messageId) internal.seenThinkingTokenMessageIds.add(messageId);

    const bucket =
      internal.liveTokenEstimate?.bucketKey ?? normalizeModel(fallbackModel).bucketKey;
    internal.estimatedReasoningByBucket.set(
      bucket,
      (internal.estimatedReasoningByBucket.get(bucket) ?? 0) + delta,
    );
  } catch {
    // Approximate telemetry must never interrupt SDK message translation.
  }
}

export function emitThinkingUsageCorrection(
  emit: EmitFn,
  internal: InternalSession,
  fallbackModel: string,
  result: ClaudeResultUsageMessage,
): void {
  const modelBuckets = collectModelBuckets(result.modelUsage);
  const estimates = normalizedEstimates(internal, modelBuckets);
  const authoritative = finiteNonNegativeInteger(
    result.usage?.output_tokens_details?.thinking_tokens,
  );

  if (authoritative !== null) {
    const aggregateOutput =
      finiteNonNegativeInteger(result.usage?.output_tokens) ??
      modelBuckets.reduce((sum, entry) => sum + entry.outputTokens, 0);
    const target = Math.min(authoritative, aggregateOutput);
    const remainder = Math.max(0, target - totalPersistedReasoning(internal));
    if (remainder <= 0) return;

    if (modelBuckets.length > 0) {
      for (const allocation of allocateAggregateReasoning(
        remainder,
        internal,
        modelBuckets,
        estimates,
      )) {
        emitReasoningOnly(
          emit,
          result.uuid,
          allocation.bucket,
          allocation.model,
          allocation.allocated,
        );
      }
      return;
    }

    const bucket = normalizeModel(fallbackModel).bucketKey;
    emitReasoningOnly(emit, result.uuid, bucket, fallbackModel, remainder);
    return;
  }

  const modelByBucket = new Map(modelBuckets.map((entry) => [entry.bucket, entry]));
  const aggregateOutput = finiteNonNegativeInteger(result.usage?.output_tokens);
  const fallbackBucket = normalizeModel(fallbackModel).bucketKey;
  const candidates: AllocationCandidate[] = [];
  for (const [bucket, rawEstimate] of estimates) {
    const estimate = Math.max(0, Math.trunc(rawEstimate));
    const modelBucket = modelByBucket.get(bucket);
    const outputLimit = modelBucket?.outputTokens ?? estimate;
    const target = Math.min(estimate, outputLimit);
    const correction = Math.max(0, target - persistedReasoning(internal, bucket));
    candidates.push({
      bucket,
      model: modelBucket?.model ?? (bucket === fallbackBucket ? fallbackModel : bucket),
      outputTokens: outputLimit,
      capacity: correction,
      weight: correction,
      allocated: 0,
    });
  }

  const desiredTotal = candidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const correctionBudget = aggregateOutput === null
    ? desiredTotal
    : Math.min(
        desiredTotal,
        Math.max(0, aggregateOutput - totalPersistedReasoning(internal)),
      );
  allocateWeighted(candidates, correctionBudget, (candidate) => candidate.weight);
  for (const candidate of candidates) {
    emitReasoningOnly(
      emit,
      result.uuid,
      candidate.bucket,
      candidate.model,
      candidate.allocated,
    );
  }
}

export function resetTurnUsageAccounting(internal: InternalSession): void {
  internal.turnUsageByBucket.clear();
  internal.estimatedReasoningByBucket.clear();
  internal.seenThinkingTokenMessageIds.clear();
}
