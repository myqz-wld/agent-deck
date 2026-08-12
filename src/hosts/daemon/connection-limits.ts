import {
  DEFAULT_DAEMON_CONNECTION_LIMITS,
  type DaemonConnectionLimits,
} from './types';
import { controlQueueCapacityError } from '@protocol/control-frame-budget';

export function normalizeDaemonConnectionLimits(
  overrides: Partial<DaemonConnectionLimits> = {},
): DaemonConnectionLimits {
  const limits = { ...DEFAULT_DAEMON_CONNECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxQueuedEvents > limits.maxQueuedFrames) {
    throw new RangeError('maxQueuedEvents cannot exceed maxQueuedFrames');
  }
  const queueCapacityError = controlQueueCapacityError({
    maxFrameBytes: limits.maxFrameBytes,
    maxQueuedBytes: limits.maxQueuedBytes,
    maxQueuedFrames: limits.maxQueuedFrames,
  });
  if (queueCapacityError) throw new RangeError(queueCapacityError);
  return Object.freeze(limits);
}
