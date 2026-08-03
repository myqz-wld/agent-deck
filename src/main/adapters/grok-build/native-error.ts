import { RequestError } from '@agentclientprotocol/sdk';

export type GrokContextWindowRejectionCode =
  | 'context_length_exceeded'
  | 'context_window_exceeded'
  | 'model_context_window_exceeded';

export type GrokTurnFailureReason = 'context-window-exceeded';

const CONTEXT_WINDOW_REJECTION_CODES = new Set<GrokContextWindowRejectionCode>([
  'context_length_exceeded',
  'context_window_exceeded',
  'model_context_window_exceeded',
]);
const CODE_FIELDS = [
  'code',
  'type',
  'error_type',
  'errorType',
  'reason',
  'stop_reason',
  'stopReason',
] as const;
const NESTED_EVIDENCE_FIELDS = ['error', 'cause', 'details', 'response'] as const;

/** Exact native codes observed in Grok's structured sampler/terminal surfaces. */
export function grokContextWindowRejectionCode(
  value: unknown,
): GrokContextWindowRejectionCode | null {
  if (typeof value !== 'string') return null;
  const code = value.trim() as GrokContextWindowRejectionCode;
  return CONTEXT_WINDOW_REJECTION_CODES.has(code) ? code : null;
}

/** Inspect only allowlisted structured code slots; message/agent-result text is never evidence. */
export function structuredGrokContextWindowRejectionCode(
  value: unknown,
): GrokContextWindowRejectionCode | null {
  return findStructuredCode(value, 0);
}

/** JSON-RPC message text alone is intentionally insufficient for retry classification. */
export function grokContextWindowRejectionFromRequestError(
  error: unknown,
): GrokContextWindowRejectionCode | null {
  return error instanceof RequestError
    ? structuredGrokContextWindowRejectionCode(error.data)
    : null;
}

export function grokContextWindowFailureReason(
  code: GrokContextWindowRejectionCode | null,
): GrokTurnFailureReason | null {
  return code ? 'context-window-exceeded' : null;
}

export function grokTurnFailureReasonFromRequestError(
  error: unknown,
): GrokTurnFailureReason | null {
  return grokContextWindowFailureReason(
    grokContextWindowRejectionFromRequestError(error),
  );
}

function findStructuredCode(
  value: unknown,
  depth: number,
): GrokContextWindowRejectionCode | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const field of CODE_FIELDS) {
    const code = grokContextWindowRejectionCode(record[field]);
    if (code) return code;
  }
  if (depth >= 2) return null;
  for (const field of NESTED_EVIDENCE_FIELDS) {
    const code = findStructuredCode(record[field], depth + 1);
    if (code) return code;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
