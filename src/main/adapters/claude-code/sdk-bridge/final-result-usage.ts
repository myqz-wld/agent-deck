import { reportedTokenUsageMetricScope } from '@main/adapters/token-usage-metric-scope';
import { normalizeModel } from '@shared/model-normalize';
import { TOKEN_USAGE_METRIC, type AgentEvent } from '@shared/types';
import type { ClaudeUsageTotals, InternalSession } from './types';

const CLAUDE_UNATTRIBUTED_REASONING_MODEL = 'claude-unattributed-reasoning';
const ZERO_USAGE: ClaudeUsageTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheCreation: 0,
};

type EmitUsage = (kind: AgentEvent['kind'], payload: unknown) => void;

interface ReportedUsage {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
}

export interface ClaudeAssistantUsageMessage {
  id?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number | null } | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

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
      contextWindow?: number;
      canonicalModel?: string;
    }
  >;
}

export interface ClaudeFinalUsageReconciliation {
  outputTokens: number;
  liveRateModel: string | null;
}

/** Persist authoritative per-API-call assistant usage, deduping progressive frames by message id. */
export function emitClaudeAssistantUsage(
  emit: EmitUsage,
  fallbackModel: string,
  message: ClaudeAssistantUsageMessage,
  internal: InternalSession,
): void {
  const usage = assistantReportedUsage(message.usage);
  const messageId = nonEmptyString(message.id);
  if (!messageId || !hasReportedUsage(usage)) return;

  const current = totalsFromReported(usage);
  const previous = internal.seenUsageMessageIds.get(messageId);
  const next = previous ? maxTotals(previous, current) : current;
  const delta = previous ? positiveDelta(next, previous) : next;
  if (previous && !hasPositiveUsage(delta)) return;

  internal.seenUsageMessageIds.set(messageId, next);
  const model = nonEmptyString(message.model) ?? fallbackModel;
  addTurnUsage(internal, normalizeModel(model).bucketKey, delta);
  emitUsageRow(emit, messageId, model, usage);
}

/**
 * Reconcile a cumulative SDK result against the previous result watermark and current-turn
 * assistant rows. Only the missing positive remainder is emitted; the returned output count is
 * the current turn's value used to calibrate tok/s.
 */
export function reconcileClaudeFinalResultUsage(
  emit: EmitUsage,
  fallbackModel: string,
  result: ClaudeFinalResultUsage,
  internal: InternalSession,
): ClaudeFinalUsageReconciliation {
  try {
    return reconcile(emit, fallbackModel, result, internal);
  } catch {
    return {
      outputTokens: sumTurnUsage(internal).output,
      liveRateModel: null,
    };
  } finally {
    internal.claudeResultBaselinePending = false;
  }
}

function reconcile(
  emit: EmitUsage,
  fallbackModel: string,
  result: ClaudeFinalResultUsage,
  internal: InternalSession,
): ClaudeFinalUsageReconciliation {
  const baselineOnly = internal.claudeResultBaselinePending === true;
  const assistantRemaining = cloneUsageMap(internal.turnUsageByBucket);
  const assistantTotal = sumTurnUsage(internal);
  const aggregate = aggregateReportedUsage(result.usage);
  const aggregateObserved = hasReportedUsage(aggregate);
  const aggregateDelta = aggregateObserved
    ? cumulativeDelta(
        aggregate,
        internal.claudeAggregateResultUsage,
        baselineOnly,
      )
    : emptyReportedUsage();
  if (aggregateObserved) {
    internal.claudeAggregateResultUsage = updateWatermark(
      aggregate,
      internal.claudeAggregateResultUsage,
    );
  }

  const entries = Object.entries(result.modelUsage ?? {});
  const modelWatermarks = internal.claudeResultUsageByModel ??= new Map();
  const perModel: Array<{ model: string; delta: ReportedUsage; output: number }> = [];
  const singleModel = entries.length === 1;

  for (const [model, usage] of entries) {
    const current = modelReportedUsage(usage, aggregate, singleModel);
    if (!hasReportedUsage(current)) continue;
    const delta = cumulativeDelta(current, modelWatermarks.get(model), baselineOnly);
    modelWatermarks.set(model, updateWatermark(current, modelWatermarks.get(model)));
    perModel.push({ model, delta, output: delta.output ?? 0 });
  }

  let correctionOutput = 0;
  if (perModel.length > 0) {
    for (const item of perModel) {
      const bucketKey = normalizeModel(item.model).bucketKey;
      const correction = subtractReported(
        item.delta,
        assistantRemaining.get(bucketKey) ?? ZERO_USAGE,
      );
      consumeAssistantRemainder(assistantRemaining, bucketKey, item.delta);
      if (singleModel && aggregateDelta.reasoning !== null) {
        correction.reasoning = Math.max(
          aggregateDelta.reasoning - assistantTotal.reasoning,
          0,
        );
      } else if (aggregateDelta.reasoning === 0) {
        // An exact aggregate zero is safe to attribute to every model; a positive multi-model
        // value is not and remains in the unattributed reasoning bucket below.
        correction.reasoning = 0;
      } else {
        correction.reasoning = null;
      }
      if (hasPositiveReportedUsage(correction)) {
        correctionOutput += correction.output ?? 0;
        emitUsageRow(
          emit,
          result.uuid
            ? `result-delta-v2:${result.uuid}:model:${encodeURIComponent(item.model)}`
            : null,
          item.model,
          correction,
        );
      }
    }
    if (!singleModel && aggregateDelta.reasoning !== null) {
      const reasoningCorrection = Math.max(
        aggregateDelta.reasoning - assistantTotal.reasoning,
        0,
      );
      if (reasoningCorrection > 0) {
        emitUnattributedReasoningUsage(emit, result.uuid, reasoningCorrection);
      }
    }
  } else if (aggregateObserved) {
    const bucketKey = normalizeModel(fallbackModel).bucketKey;
    const correction = subtractReported(
      aggregateDelta,
      assistantRemaining.get(bucketKey) ?? ZERO_USAGE,
    );
    if (hasPositiveReportedUsage(correction)) {
      correctionOutput = correction.output ?? 0;
      emitUsageRow(
        emit,
        result.uuid ? `result-delta-v2:${result.uuid}:aggregate` : null,
        fallbackModel,
        correction,
      );
    }
  }

  const authoritativeOutput = perModel.length > 0
    ? perModel.reduce((sum, item) => sum + item.output, 0)
    : aggregateDelta.output ?? 0;
  const outputTokens = Math.max(
    assistantTotal.output + correctionOutput,
    authoritativeOutput,
  );
  const outputModels = perModel.filter((item) => item.output > 0);
  return {
    outputTokens,
    liveRateModel:
      outputModels.length === 1
        ? outputModels[0].model
        : perModel.length === 1
          ? perModel[0].model
          : null,
  };
}

function assistantReportedUsage(
  usage: ClaudeAssistantUsageMessage['usage'],
): ReportedUsage {
  return {
    input: reportedUsageValue(usage?.input_tokens),
    output: reportedUsageValue(usage?.output_tokens),
    reasoning: reportedUsageValue(usage?.output_tokens_details?.thinking_tokens),
    cacheRead: reportedUsageValue(usage?.cache_read_input_tokens),
    cacheCreation: reportedUsageValue(usage?.cache_creation_input_tokens),
  };
}

function aggregateReportedUsage(
  usage: ClaudeFinalResultUsage['usage'],
): ReportedUsage {
  return {
    input: reportedUsageValue(usage?.input_tokens),
    output: reportedUsageValue(usage?.output_tokens),
    reasoning: reportedUsageValue(usage?.output_tokens_details?.thinking_tokens),
    cacheRead: reportedUsageValue(usage?.cache_read_input_tokens),
    cacheCreation: reportedUsageValue(usage?.cache_creation_input_tokens),
  };
}

function modelReportedUsage(
  usage: NonNullable<ClaudeFinalResultUsage['modelUsage']>[string],
  aggregate: ReportedUsage,
  singleModel: boolean,
): ReportedUsage {
  return {
    input: reportedUsageValue(usage.inputTokens) ?? (singleModel ? aggregate.input : null),
    output: reportedUsageValue(usage.outputTokens) ?? (singleModel ? aggregate.output : null),
    reasoning: null,
    cacheRead:
      reportedUsageValue(usage.cacheReadInputTokens)
      ?? (singleModel ? aggregate.cacheRead : null),
    cacheCreation:
      reportedUsageValue(usage.cacheCreationInputTokens)
      ?? (singleModel ? aggregate.cacheCreation : null),
  };
}

function cumulativeDelta(
  current: ReportedUsage,
  previous: ClaudeUsageTotals | undefined,
  baselineOnly: boolean,
): ReportedUsage {
  if (baselineOnly) return mapReported(current, () => 0);
  if (!previous) return { ...current };
  const reset = usageFields().some((field) => {
    const value = current[field];
    return value !== null && value < previous[field];
  });
  return mapReported(current, (value, field) =>
    reset ? value : Math.max(value - previous[field], 0));
}

function updateWatermark(
  current: ReportedUsage,
  previous: ClaudeUsageTotals | undefined,
): ClaudeUsageTotals {
  const next = { ...(previous ?? ZERO_USAGE) };
  for (const field of usageFields()) {
    if (current[field] !== null) next[field] = current[field];
  }
  return next;
}

function subtractReported(current: ReportedUsage, seen: ClaudeUsageTotals): ReportedUsage {
  return mapReported(current, (value, field) => Math.max(value - seen[field], 0));
}

function consumeAssistantRemainder(
  remaining: Map<string, ClaudeUsageTotals>,
  bucketKey: string,
  delta: ReportedUsage,
): void {
  const current = remaining.get(bucketKey);
  if (!current) return;
  const next = { ...current };
  for (const field of usageFields()) {
    next[field] = Math.max(next[field] - (delta[field] ?? 0), 0);
  }
  remaining.set(bucketKey, next);
}

function addTurnUsage(
  internal: InternalSession,
  bucketKey: string,
  delta: ClaudeUsageTotals,
): void {
  const current = internal.turnUsageByBucket.get(bucketKey) ?? ZERO_USAGE;
  internal.turnUsageByBucket.set(bucketKey, addTotals(current, delta));
}

function sumTurnUsage(internal: InternalSession): ClaudeUsageTotals {
  let total = { ...ZERO_USAGE };
  for (const usage of internal.turnUsageByBucket.values()) total = addTotals(total, usage);
  return total;
}

function cloneUsageMap(
  source: Map<string, ClaudeUsageTotals>,
): Map<string, ClaudeUsageTotals> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function addTotals(left: ClaudeUsageTotals, right: ClaudeUsageTotals): ClaudeUsageTotals {
  return mapTotals(left, (value, field) => value + right[field]);
}

function maxTotals(left: ClaudeUsageTotals, right: ClaudeUsageTotals): ClaudeUsageTotals {
  return mapTotals(left, (value, field) => Math.max(value, right[field]));
}

function positiveDelta(next: ClaudeUsageTotals, previous: ClaudeUsageTotals): ClaudeUsageTotals {
  return mapTotals(next, (value, field) => Math.max(value - previous[field], 0));
}

function totalsFromReported(usage: ReportedUsage): ClaudeUsageTotals {
  return mapTotals(ZERO_USAGE, (_value, field) => usage[field] ?? 0);
}

function mapTotals(
  source: ClaudeUsageTotals,
  fn: (value: number, field: keyof ClaudeUsageTotals) => number,
): ClaudeUsageTotals {
  return {
    input: fn(source.input, 'input'),
    output: fn(source.output, 'output'),
    reasoning: fn(source.reasoning, 'reasoning'),
    cacheRead: fn(source.cacheRead, 'cacheRead'),
    cacheCreation: fn(source.cacheCreation, 'cacheCreation'),
  };
}

function mapReported(
  source: ReportedUsage,
  fn: (value: number, field: keyof ReportedUsage) => number,
): ReportedUsage {
  return {
    input: source.input === null ? null : fn(source.input, 'input'),
    output: source.output === null ? null : fn(source.output, 'output'),
    reasoning: source.reasoning === null ? null : fn(source.reasoning, 'reasoning'),
    cacheRead: source.cacheRead === null ? null : fn(source.cacheRead, 'cacheRead'),
    cacheCreation:
      source.cacheCreation === null ? null : fn(source.cacheCreation, 'cacheCreation'),
  };
}

function emitUsageRow(
  emit: EmitUsage,
  messageId: string | null,
  model: string,
  usage: ReportedUsage,
): void {
  emit('token-usage', {
    messageId,
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    cacheReadTokens: usage.cacheRead,
    cacheCreationTokens: usage.cacheCreation,
    metricScope: reportedTokenUsageMetricScope({
      inputTokens: usage.input,
      outputTokens: usage.output,
      reasoningTokens: usage.reasoning,
      cacheReadTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheCreation,
    }, { requireProviderTotal: true }),
  });
}

function emitUnattributedReasoningUsage(
  emit: EmitUsage,
  uuid: string | undefined,
  reasoningTokens: number,
): void {
  emit('token-usage', {
    messageId: uuid ? `result-delta-v2:${uuid}:reasoning:unattributed` : null,
    model: CLAUDE_UNATTRIBUTED_REASONING_MODEL,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    metricScope: TOKEN_USAGE_METRIC.reasoning,
  });
}

function emptyReportedUsage(): ReportedUsage {
  return { input: null, output: null, reasoning: null, cacheRead: null, cacheCreation: null };
}

function usageFields(): Array<keyof ClaudeUsageTotals> {
  return ['input', 'output', 'reasoning', 'cacheRead', 'cacheCreation'];
}

function hasReportedUsage(usage: ReportedUsage): boolean {
  return usageFields().some((field) => usage[field] !== null);
}

function hasPositiveReportedUsage(usage: ReportedUsage): boolean {
  return usageFields().some((field) => (usage[field] ?? 0) > 0);
}

function hasPositiveUsage(usage: ClaudeUsageTotals): boolean {
  return usageFields().some((field) => usage[field] > 0);
}

function reportedUsageValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
