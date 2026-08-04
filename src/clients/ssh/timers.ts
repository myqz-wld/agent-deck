import { MAX_NODE_TIMER_DELAY_MS } from './limits';

type Timer = ReturnType<typeof setTimeout>;

export interface LongTimer {
  cancel(): void;
}

/** Chunks long delays so Node never coerces an overflowing timeout to roughly 1 ms. */
export function scheduleLongTimeout(delayMs: number, callback: () => void): LongTimer {
  let remaining = Math.max(0, delayMs);
  let timer: Timer | null = null;
  let cancelled = false;

  const arm = (): void => {
    if (cancelled) return;
    const horizon = Math.min(remaining, MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      remaining -= horizon;
      if (remaining <= 0) {
        cancelled = true;
        callback();
      } else {
        arm();
      }
    }, horizon);
  };

  arm();
  return {
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function assertSafeTimerHorizon(
  value: number,
  field: string,
  allowZero = false,
): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${MAX_NODE_TIMER_DELAY_MS}`,
    );
  }
}
