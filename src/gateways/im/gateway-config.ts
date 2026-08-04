import { FeishuGatewayError } from './errors';
import type { FeishuGatewayClock, FeishuGatewayLimits } from './types';

export const DEFAULT_GATEWAY_CLOCK: FeishuGatewayClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

const DEFAULT_LIMITS: FeishuGatewayLimits = Object.freeze({
  maxEventBytes: 32_768,
  maxTextBytes: 16_384,
  maxOutputBytes: 12_000,
  maxSessions: 25,
  maxHistoryEntries: 20,
  maxPendingCards: 12,
  maxQueuedNotificationsPerChat: 32,
  maxTransportAttemptsPerCallback: 2,
  maxEventAttempts: 3,
  maxSessionResults: 250,
  maxPendingResults: 64,
  maxCoreResponseBytes: 64_000,
  maxCoreJsonDepth: 8,
  maxCoreJsonEntries: 4_096,
  maxCoreFieldBytes: 4_096,
  maxSubscriptionsPerChat: 16,
  maxNotificationCoreRequests: 8,
  deliveryAttemptLifetimeMs: 30_000,
  maxActiveCredentials: 64,
  maxPersistedContexts: 1_000,
  maxConcurrentChatClients: 256,
  maxNotificationLanes: 256,
});

const LIMIT_CEILINGS: Readonly<Record<keyof FeishuGatewayLimits, number>> = {
  maxEventBytes: 1_000_000,
  maxTextBytes: 256_000,
  maxOutputBytes: 256_000,
  maxSessions: 100,
  maxHistoryEntries: 100,
  maxPendingCards: 50,
  maxQueuedNotificationsPerChat: 256,
  maxTransportAttemptsPerCallback: 5,
  maxEventAttempts: 10,
  maxSessionResults: 1_000,
  maxPendingResults: 256,
  maxCoreResponseBytes: 1_000_000,
  maxCoreJsonDepth: 16,
  maxCoreJsonEntries: 16_384,
  maxCoreFieldBytes: 64_000,
  maxSubscriptionsPerChat: 64,
  maxNotificationCoreRequests: 32,
  deliveryAttemptLifetimeMs: 300_000,
  maxActiveCredentials: 1_000,
  maxPersistedContexts: 10_000,
  maxConcurrentChatClients: 1_000,
  maxNotificationLanes: 1_000,
};

export function requireSafeDuration(
  value: number,
  field: string,
  maximum?: number,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || (maximum !== undefined && value > maximum)) {
    throw new FeishuGatewayError('invalid_configuration', `${field} is outside the safe range`);
  }
  return value;
}

export function resolveGatewayLimits(
  input: Partial<FeishuGatewayLimits> | undefined,
): FeishuGatewayLimits {
  const merged = { ...DEFAULT_LIMITS, ...input };
  for (const field of Object.keys(merged) as Array<keyof FeishuGatewayLimits>) {
    const value = merged[field];
    if (!Number.isSafeInteger(value) || value <= 0 || value > LIMIT_CEILINGS[field]) {
      throw new FeishuGatewayError(
        'invalid_configuration',
        `${field} must be a positive bounded integer`,
      );
    }
  }
  return merged;
}
