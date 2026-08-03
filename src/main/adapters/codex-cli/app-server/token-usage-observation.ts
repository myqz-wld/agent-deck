type AnyRecord = Record<string, unknown>;

export interface CodexTokenUsageSnapshot {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
}

export interface CodexTokenUsageObservation {
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  delta: CodexTokenUsageSnapshot | null;
  watermark: CodexTokenUsageSnapshot | undefined;
  messageId: string | null;
  hasCumulativeSnapshot: boolean;
}

const FIELDS: Array<keyof CodexTokenUsageSnapshot> = [
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
];

/** Convert Codex cumulative totals into one additive observation and reject unchanged replays. */
export function observeCodexTokenUsage(
  params: unknown,
  previous?: CodexTokenUsageSnapshot,
  messageNamespace?: string | null,
): CodexTokenUsageObservation {
  const usage = asRecord(asRecord(params)?.tokenUsage);
  const last = readSnapshot(asRecord(usage?.last));
  const total = readSnapshot(asRecord(usage?.total));
  const hasCumulativeSnapshot = hasReportedMetric(total);
  const watermark = hasCumulativeSnapshot
    ? mergeSnapshot(previous, total!)
    : previous;
  const delta = hasCumulativeSnapshot
    ? deltaFromCumulative(total!, previous, last)
    : last;
  return {
    contextUsedTokens: last?.totalTokens ?? null,
    contextWindowTokens: positiveNumberField(usage?.modelContextWindow),
    delta,
    watermark,
    messageId:
      hasCumulativeSnapshot && messageNamespace && watermark
        ? cumulativeMessageId(messageNamespace, watermark)
        : null,
    hasCumulativeSnapshot,
  };
}

function deltaFromCumulative(
  current: CodexTokenUsageSnapshot,
  previous: CodexTokenUsageSnapshot | undefined,
  last: CodexTokenUsageSnapshot | null,
): CodexTokenUsageSnapshot {
  // On the first observation, `last` is the provider's current API-call delta and works for both
  // new and resumed threads. The cumulative fingerprint still makes a replay idempotent in DB.
  if (!previous) return last ?? current;
  const reset = FIELDS.some((field) => {
    const next = current[field];
    const before = previous[field];
    return next !== null && before !== null && next < before;
  });
  if (reset) return last ?? current;
  return mapSnapshot(current, (value, field) => {
    const before = previous[field];
    return before === null ? value : Math.max(value - before, 0);
  });
}

function mergeSnapshot(
  previous: CodexTokenUsageSnapshot | undefined,
  current: CodexTokenUsageSnapshot,
): CodexTokenUsageSnapshot {
  if (!previous) return { ...current };
  return {
    totalTokens: current.totalTokens ?? previous.totalTokens,
    inputTokens: current.inputTokens ?? previous.inputTokens,
    outputTokens: current.outputTokens ?? previous.outputTokens,
    reasoningOutputTokens:
      current.reasoningOutputTokens ?? previous.reasoningOutputTokens,
    cachedInputTokens: current.cachedInputTokens ?? previous.cachedInputTokens,
    cacheWriteInputTokens:
      current.cacheWriteInputTokens ?? previous.cacheWriteInputTokens,
  };
}

function readSnapshot(record: AnyRecord | null): CodexTokenUsageSnapshot | null {
  if (!record) return null;
  const snapshot = {
    totalTokens: numberField(record.totalTokens),
    inputTokens: numberField(record.inputTokens),
    outputTokens: numberField(record.outputTokens),
    reasoningOutputTokens: numberField(record.reasoningOutputTokens),
    cachedInputTokens: numberField(record.cachedInputTokens),
    cacheWriteInputTokens: numberField(record.cacheWriteInputTokens),
  };
  return hasReportedMetric(snapshot) ? snapshot : null;
}

function mapSnapshot(
  source: CodexTokenUsageSnapshot,
  fn: (
    value: number,
    field: keyof CodexTokenUsageSnapshot,
  ) => number | null,
): CodexTokenUsageSnapshot {
  const value = (field: keyof CodexTokenUsageSnapshot): number | null => {
    const current = source[field];
    return current === null ? null : fn(current, field);
  };
  return {
    totalTokens: value('totalTokens'),
    inputTokens: value('inputTokens'),
    outputTokens: value('outputTokens'),
    reasoningOutputTokens: value('reasoningOutputTokens'),
    cachedInputTokens: value('cachedInputTokens'),
    cacheWriteInputTokens: value('cacheWriteInputTokens'),
  };
}

function cumulativeMessageId(
  namespace: string,
  snapshot: CodexTokenUsageSnapshot,
): string {
  const fingerprint = FIELDS.map((field) => snapshot[field] ?? 'x').join('-');
  return `codex-usage-v2:${encodeURIComponent(namespace)}:${fingerprint}`;
}

function hasReportedMetric(
  snapshot: CodexTokenUsageSnapshot | null,
): snapshot is CodexTokenUsageSnapshot {
  return snapshot !== null && FIELDS.some((field) => snapshot[field] !== null);
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
