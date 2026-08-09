import {
  DEFAULT_DAEMON_CONNECTION_LIMITS,
  type DaemonConnectionLimits,
} from './types';

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
  return Object.freeze(limits);
}
