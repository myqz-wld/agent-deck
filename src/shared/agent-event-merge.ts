export const APPEND_AGGREGATED_OUTPUT = '__appendAggregatedOutput';

type AnyRecord = Record<string, unknown>;

/**
 * Merge repeated tool-use payloads for the same toolUseId.
 *
 * Tool progress updates often omit stable identity fields such as toolInput.command.
 * Keep those stable fields from the previous payload while letting the newest status
 * fields win. App-server command output sends deltas, marked by APPEND_AGGREGATED_OUTPUT,
 * so only that path appends stdout instead of replacing it.
 */
export function mergeToolUsePayload(previous: unknown, incoming: unknown): unknown {
  const prev = asRecord(previous);
  const next = asRecord(incoming);
  if (!next) return sanitizeToolUsePayload(incoming);
  if (!prev) return sanitizeToolUsePayload(next);

  const merged: AnyRecord = { ...prev, ...next };

  if (next.toolInput === undefined && prev.toolInput !== undefined) {
    merged.toolInput = prev.toolInput;
  } else {
    const prevInput = asRecord(prev.toolInput);
    const nextInput = asRecord(next.toolInput);
    if (prevInput && nextInput) merged.toolInput = { ...prevInput, ...nextInput };
  }

  if (next[APPEND_AGGREGATED_OUTPUT] === true) {
    const before = typeof prev.aggregatedOutput === 'string' ? prev.aggregatedOutput : '';
    const delta = typeof next.aggregatedOutput === 'string' ? next.aggregatedOutput : '';
    merged.aggregatedOutput = before + delta;
  }

  delete merged[APPEND_AGGREGATED_OUTPUT];
  return merged;
}

export function sanitizeToolUsePayload(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record) return payload;
  const clean = { ...record };
  delete clean[APPEND_AGGREGATED_OUTPUT];
  return clean;
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}
