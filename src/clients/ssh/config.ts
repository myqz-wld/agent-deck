import { SshTransportError } from './errors';
import { assertSafeTimerHorizon } from './timers';
import type {
  SshReconnectPolicy,
  SshTransportBounds,
  SshTransportOptions,
  SshTransportTiming,
} from './types';

export const DEFAULT_SSH_RECONNECT_POLICY: SshReconnectPolicy = Object.freeze({
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  multiplier: 2,
  maxAttempts: 8,
});

export const DEFAULT_SSH_TRANSPORT_BOUNDS: SshTransportBounds = Object.freeze({
  maxFrameBytes: 4 * 1024 * 1024,
  maxInFlightRequests: 32,
  maxQueuedRequests: 128,
  maxQueuedWriteBytes: 8 * 1024 * 1024,
  maxQueuedWriteFrames: 128,
  maxRememberedResponses: 1_024,
  maxStderrBytes: 64 * 1024,
});

export const DEFAULT_SSH_TRANSPORT_TIMING: SshTransportTiming = Object.freeze({
  handshakeTimeoutMs: 15_000,
  pingIntervalMs: 30_000,
  pongTimeoutMs: 10_000,
  childExitGraceMs: 1_000,
  childExitKillWaitMs: 1_000,
});

export interface ResolvedSshTransportOptions {
  reconnect: SshReconnectPolicy;
  bounds: SshTransportBounds;
  timing: SshTransportTiming;
}

function requirePositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SshTransportError('invalid_profile', `${field} must be positive`);
  }
}

function requireTimer(value: number, field: string, allowZero = false): void {
  try {
    assertSafeTimerHorizon(value, field, allowZero);
  } catch (error) {
    throw new SshTransportError(
      'invalid_profile',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function resolveSshTransportOptions(
  options: SshTransportOptions,
): ResolvedSshTransportOptions {
  const reconnect = { ...DEFAULT_SSH_RECONNECT_POLICY, ...options.reconnect };
  const bounds = { ...DEFAULT_SSH_TRANSPORT_BOUNDS, ...options.bounds };
  const timing = { ...DEFAULT_SSH_TRANSPORT_TIMING, ...options.timing };

  requireTimer(reconnect.initialDelayMs, 'reconnect.initialDelayMs');
  requireTimer(reconnect.maxDelayMs, 'reconnect.maxDelayMs');
  if (!Number.isFinite(reconnect.multiplier) || reconnect.multiplier < 1) {
    throw new SshTransportError('invalid_profile', 'reconnect.multiplier must be at least one');
  }
  if (!Number.isSafeInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 0) {
    throw new SshTransportError(
      'invalid_profile',
      'reconnect.maxAttempts must be a non-negative integer',
    );
  }
  for (const [field, value] of Object.entries(bounds)) requirePositive(value, `bounds.${field}`);
  requireTimer(timing.handshakeTimeoutMs, 'timing.handshakeTimeoutMs');
  requireTimer(timing.pingIntervalMs, 'timing.pingIntervalMs', true);
  requireTimer(timing.pongTimeoutMs, 'timing.pongTimeoutMs', true);
  requireTimer(timing.childExitGraceMs, 'timing.childExitGraceMs');
  requireTimer(timing.childExitKillWaitMs, 'timing.childExitKillWaitMs');
  if ((timing.pingIntervalMs === 0) !== (timing.pongTimeoutMs === 0)) {
    throw new SshTransportError(
      'invalid_profile',
      'pingIntervalMs and pongTimeoutMs must both be zero or both be positive',
    );
  }
  return { reconnect, bounds, timing };
}
