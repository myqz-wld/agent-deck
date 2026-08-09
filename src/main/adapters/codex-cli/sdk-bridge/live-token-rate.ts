import type { CodexAppServerNotification } from '../app-server/client';
import type { CodexTokenUsageObservation } from '../app-server/token-usage-observation';
import {
  clearCodexLiveTokenEstimateCore,
  handleCodexNotificationForLiveRateCore,
  observeCodexNotificationUsageCore,
} from './live-token-rate-core';
import { desktopCodexLiveRateHost } from './live-token-rate-host';
import type { InternalSession } from './types';

export type {
  CodexLiveRateHost,
  CodexLiveRateNotification,
  CodexLiveRateOwner,
  CodexLiveTokenEstimateState,
} from './live-token-rate-core';

export function handleCodexAppServerNotificationForLiveRate(
  notification: CodexAppServerNotification,
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
  usageObservation?: CodexTokenUsageObservation,
): void {
  handleCodexNotificationForLiveRateCore(
    notification,
    internal,
    sessionId,
    now,
    desktopCodexLiveRateHost,
    usageObservation,
  );
}

export function observeCodexNotificationUsage(
  notification: CodexAppServerNotification,
  internal: InternalSession,
): CodexTokenUsageObservation | undefined {
  return observeCodexNotificationUsageCore(notification, internal);
}

export function clearCodexLiveTokenEstimate(
  internal: InternalSession,
  sessionId: string,
  now = Date.now(),
): void {
  clearCodexLiveTokenEstimateCore(internal, sessionId, now, desktopCodexLiveRateHost);
}
