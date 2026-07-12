import { performance } from 'node:perf_hooks';

import log from '@main/utils/logger';

const logger = log.scope('main-event-loop');

const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_WARN_THRESHOLD_MS = 500;
const DEFAULT_WARNING_COOLDOWN_MS = 10_000;
const DEFAULT_SUSPEND_THRESHOLD_MS = 60_000;

export interface EventLoopDelaySample {
  lagMs: number;
  sampleIntervalMs: number;
  suppressedSinceLastWarning: number;
  maxSuppressedLagMs: number;
}

interface EventLoopMonitorOptions {
  sampleIntervalMs?: number;
  warnThresholdMs?: number;
  warningCooldownMs?: number;
  suspendThresholdMs?: number;
  now?: () => number;
  onDelay?: (sample: EventLoopDelaySample) => void;
}

/**
 * Monitor Electron's main event-loop drift so rare global stalls can be separated from slow
 * MCP handlers or SQLite writes. Delays longer than suspendThresholdMs are ignored because they
 * are normally laptop sleep/wake, not actionable in-process latency.
 */
export function startMainEventLoopMonitor(options: EventLoopMonitorOptions = {}): () => void {
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
  const warningCooldownMs = options.warningCooldownMs ?? DEFAULT_WARNING_COOLDOWN_MS;
  const suspendThresholdMs = options.suspendThresholdMs ?? DEFAULT_SUSPEND_THRESHOLD_MS;
  const now = options.now ?? (() => performance.now());
  const onDelay =
    options.onDelay ??
    ((sample: EventLoopDelaySample) => {
      logger.warn('[performance] main event loop delay detected', {
        lagMs: Math.round(sample.lagMs),
        sampleIntervalMs: sample.sampleIntervalMs,
        suppressedSinceLastWarning: sample.suppressedSinceLastWarning,
        maxSuppressedLagMs: Math.round(sample.maxSuppressedLagMs),
      });
    });

  let expectedAt = now() + sampleIntervalMs;
  let lastWarningAt = Number.NEGATIVE_INFINITY;
  let suppressedSinceLastWarning = 0;
  let maxSuppressedLagMs = 0;

  const timer = setInterval(() => {
    const current = now();
    const lagMs = Math.max(0, current - expectedAt);
    // Rebase on the actual callback time. This avoids reporting the same stall on every tick.
    expectedAt = current + sampleIntervalMs;

    if (lagMs < warnThresholdMs || lagMs >= suspendThresholdMs) return;
    if (current - lastWarningAt < warningCooldownMs) {
      suppressedSinceLastWarning += 1;
      maxSuppressedLagMs = Math.max(maxSuppressedLagMs, lagMs);
      return;
    }

    onDelay({
      lagMs,
      sampleIntervalMs,
      suppressedSinceLastWarning,
      maxSuppressedLagMs,
    });
    lastWarningAt = current;
    suppressedSinceLastWarning = 0;
    maxSuppressedLagMs = 0;
  }, sampleIntervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
