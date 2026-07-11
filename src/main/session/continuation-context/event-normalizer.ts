import { createHash } from 'node:crypto';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import type { NormalizedContinuationEvent } from './types';
import { truncateContinuationTextMiddle, utf8ByteLength } from './token-estimator';

export const MAX_NORMALIZED_EVENT_UTF8_BYTES = 32 * 1024;

const EXCLUDED_EVENT_KINDS = new Set(['thinking', 'token-usage']);

/** Normalize one immutable spool row while keeping oversized or malformed evidence bounded. */
export function normalizeContinuationEvent(
  row: RawEventRevisionRow,
  maxUtf8Bytes = MAX_NORMALIZED_EVENT_UTF8_BYTES,
): NormalizedContinuationEvent | null {
  if (EXCLUDED_EVENT_KINDS.has(row.kind)) return null;
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 256) {
    throw new Error('maxUtf8Bytes must be a safe integer of at least 256');
  }
  const sourceBytes = utf8ByteLength(row.payloadJson);
  const sourceHash = createHash('sha256').update(row.payloadJson, 'utf8').digest('hex');
  let payload: unknown;
  let truncated = false;

  if (sourceBytes <= maxUtf8Bytes) {
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch {
      payload = { malformedPayloadJson: row.payloadJson };
    }
  } else {
    const tokenBudget = Math.max(32, Math.floor(maxUtf8Bytes / 5));
    const bounded = truncateContinuationTextMiddle(row.payloadJson, tokenBudget);
    payload = {
      truncatedPayloadJson: bounded.text,
      originalUtf8Bytes: sourceBytes,
      originalSha256: sourceHash,
    };
    truncated = true;
  }

  return {
    eventId: row.id,
    effectiveRevision: row.effectiveRevision,
    kind: row.kind,
    ts: row.ts,
    payload,
    sourceBytes,
    sourceHash,
    truncated,
  };
}
