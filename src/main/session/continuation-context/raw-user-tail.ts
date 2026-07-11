import type { RawContinuationUserInput } from './types';
import type { ClassifiedContinuationMessage } from './message-classifier';
import {
  estimateContinuationJsonTokens,
  truncateContinuationTextMiddle,
} from './token-estimator';

export const CONTINUATION_RAW_QUERY_PAGE_SIZE = 128;

export interface RawUserTailSelection {
  messages: RawContinuationUserInput[];
  estimatedTokens: number;
  truncatedBoundaryMessages: number;
  stoppedAtEventId: number | null;
}

function toRawInput(
  message: ClassifiedContinuationMessage,
  text = message.text,
  truncated = false,
  omittedEstimatedTokens = 0,
): RawContinuationUserInput {
  return {
    eventId: message.eventId,
    effectiveRevision: message.effectiveRevision,
    ts: message.ts,
    text,
    attachments: message.attachments,
    origin: message.origin,
    truncated,
    omittedEstimatedTokens,
  };
}

function messageTokens(message: RawContinuationUserInput): number {
  return estimateContinuationJsonTokens(message, { structuralOverhead: 4 });
}

function truncateStoredInputToBudget(
  message: RawContinuationUserInput,
  tokenBudget: number,
): RawContinuationUserInput | null {
  if (!message.text || tokenBudget < 1) return null;
  const metadataOnly = { ...message, text: '', truncated: true, omittedEstimatedTokens: 0 };
  const textBudget = tokenBudget - messageTokens(metadataOnly);
  if (textBudget < 1) return null;
  let low = 1;
  let high = textBudget;
  let best: RawContinuationUserInput | null = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    try {
      const bounded = truncateContinuationTextMiddle(message.text, midpoint);
      const candidate = {
        ...message,
        text: bounded.text,
        truncated: message.truncated || bounded.truncated,
        omittedEstimatedTokens:
          message.omittedEstimatedTokens + bounded.omittedEstimatedTokens,
      };
      if (messageTokens(candidate) <= tokenBudget) {
        best = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    } catch {
      low = midpoint + 1;
    }
  }
  return best;
}

function truncateMessageToBudget(
  message: ClassifiedContinuationMessage,
  tokenBudget: number,
): RawContinuationUserInput | null {
  if (!message.text || tokenBudget < 1) return null;
  const metadataOnly = toRawInput(message, '', true, 0);
  const metadataTokens = messageTokens(metadataOnly);
  const textBudget = tokenBudget - metadataTokens;
  if (textBudget < 1) return null;
  let low = 1;
  let high = textBudget;
  let best: RawContinuationUserInput | null = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    try {
      const truncated = truncateContinuationTextMiddle(message.text, midpoint);
      const candidate = toRawInput(
        message,
        truncated.text,
        truncated.truncated,
        truncated.omittedEstimatedTokens,
      );
      if (messageTokens(candidate) <= tokenBudget) {
        best = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    } catch {
      low = midpoint + 1;
    }
  }
  return best;
}

/** Select one continuous newest suffix; truncate the first non-fitting boundary and stop. */
export function selectRawUserTail(
  candidates: ClassifiedContinuationMessage[],
  tokenBudget: number,
): RawUserTailSelection {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new Error('tokenBudget must be a non-negative safe integer');
  }
  const newestFirst = [...candidates].sort(
    (a, b) => b.effectiveRevision - a.effectiveRevision || b.eventId - a.eventId,
  );
  const selectedNewestFirst: RawContinuationUserInput[] = [];
  let estimatedTokens = 0;
  let truncatedBoundaryMessages = 0;
  let stoppedAtEventId: number | null = null;

  for (const candidate of newestFirst) {
    const full = toRawInput(candidate);
    const fullTokens = messageTokens(full);
    if (estimatedTokens + fullTokens <= tokenBudget) {
      selectedNewestFirst.push(full);
      estimatedTokens += fullTokens;
      continue;
    }
    const remaining = tokenBudget - estimatedTokens;
    const boundary = truncateMessageToBudget(candidate, remaining);
    if (boundary) {
      selectedNewestFirst.push(boundary);
      estimatedTokens += messageTokens(boundary);
      truncatedBoundaryMessages = 1;
    }
    stoppedAtEventId = candidate.eventId;
    break;
  }

  return {
    messages: selectedNewestFirst.reverse(),
    estimatedTokens,
    truncatedBoundaryMessages,
    stoppedAtEventId,
  };
}

export function estimateRawUserTailTokens(messages: RawContinuationUserInput[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

/** Re-budget an immutable captured tail while preserving one continuous newest suffix. */
export function selectStoredRawUserTail(
  chronologicalInputs: RawContinuationUserInput[],
  tokenBudget: number,
): RawUserTailSelection {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new Error('tokenBudget must be a non-negative safe integer');
  }
  const newestFirst = [...chronologicalInputs].sort(
    (left, right) =>
      right.effectiveRevision - left.effectiveRevision || right.eventId - left.eventId,
  );
  const retained: RawContinuationUserInput[] = [];
  let estimatedTokens = 0;
  let truncatedBoundaryMessages = 0;
  let stoppedAtEventId: number | null = null;
  for (const input of newestFirst) {
    const tokens = messageTokens(input);
    if (estimatedTokens + tokens <= tokenBudget) {
      retained.push({ ...input, attachments: input.attachments.map((entry) => ({ ...entry })) });
      estimatedTokens += tokens;
      continue;
    }
    const boundary = truncateStoredInputToBudget(input, tokenBudget - estimatedTokens);
    if (boundary) {
      retained.push(boundary);
      estimatedTokens += messageTokens(boundary);
      truncatedBoundaryMessages = 1;
    }
    stoppedAtEventId = input.eventId;
    break;
  }
  return {
    messages: retained.reverse(),
    estimatedTokens,
    truncatedBoundaryMessages,
    stoppedAtEventId,
  };
}
