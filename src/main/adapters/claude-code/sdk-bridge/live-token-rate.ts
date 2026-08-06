import {
  clearClaudeLiveTokenEstimateCore,
  completeClaudeLiveTokenEstimateCore,
  handleClaudeStreamEventForLiveRateCore,
} from './live-token-rate-core';
import { desktopClaudeLiveRateHost } from './live-token-rate-host';
import type { InternalSession } from './types';

export type {
  ClaudeLiveRateHost,
  ClaudeLiveRateOwner,
  ClaudeLiveTokenEstimateState,
} from './live-token-rate-core';
export { estimateClaudeTokensFromText as estimateTokensFromText } from './live-token-rate-core';

export function handleStreamEventForLiveRate(
  internal: InternalSession,
  sessionId: string,
  msg: unknown,
  now = Date.now(),
): void {
  handleClaudeStreamEventForLiveRateCore(
    internal, sessionId, msg, now, desktopClaudeLiveRateHost,
  );
}

export function completeLiveTokenEstimate(
  internal: InternalSession,
  sessionId: string,
  outputTokens: number,
  now = Date.now(),
  modelOverride?: string | null,
): boolean {
  return completeClaudeLiveTokenEstimateCore(
    internal,
    sessionId,
    outputTokens,
    now,
    modelOverride,
    desktopClaudeLiveRateHost,
  );
}

export function clearLiveTokenEstimate(
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
): void {
  clearClaudeLiveTokenEstimateCore(internal, sessionId, now, desktopClaudeLiveRateHost);
}
