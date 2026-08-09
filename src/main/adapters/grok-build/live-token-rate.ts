import {
  beginGrokLiveTokenRateCore,
  clearGrokLiveTokenRateCore,
  completeGrokLiveTokenRateCore,
  handleGrokTextForLiveRateCore,
  type GrokLiveRateOwner,
} from './live-token-rate-core';
import { desktopGrokLiveRateObserver } from './live-token-rate-host';

export type { GrokLiveRateOwner, GrokLiveRateState } from './live-token-rate-core';
export { estimateGrokTokensFromText } from './live-token-rate-core';

export function beginGrokLiveTokenRate(
  owner: GrokLiveRateOwner,
  sessionId: string,
  model: string | null,
  now = Date.now(),
): void {
  beginGrokLiveTokenRateCore(owner, sessionId, model, now);
}

export function handleGrokTextForLiveRate(
  owner: GrokLiveRateOwner,
  text: string,
  now = Date.now(),
): void {
  handleGrokTextForLiveRateCore(
    owner,
    text,
    now,
    desktopGrokLiveRateObserver,
  );
}

export function completeGrokLiveTokenRate(
  owner: GrokLiveRateOwner,
  outputTokens: number,
  now = Date.now(),
  durationMs?: number,
): boolean {
  return completeGrokLiveTokenRateCore(
    owner,
    outputTokens,
    now,
    durationMs,
    desktopGrokLiveRateObserver,
  );
}

export function clearGrokLiveTokenRate(
  owner: GrokLiveRateOwner,
  now = Date.now(),
): void {
  clearGrokLiveTokenRateCore(owner, now, desktopGrokLiveRateObserver);
}
