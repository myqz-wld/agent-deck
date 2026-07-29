import type { TokenDailyRow, TokenUsageQueryOptions } from '@shared/types';
import { useTokenUsageStore } from '../stores/token-usage-store';
import log from '@renderer/utils/logger';

const logger = log.scope('renderer-token-daily-refresh');
const DEFAULT_DEBOUNCE_MS = 500;

interface CoordinatorDependencies {
  read(options?: TokenUsageQueryOptions): Promise<TokenDailyRow[]>;
  apply(rows: TokenDailyRow[]): void;
  subscribe?(listener: () => void): () => void;
  warn?(): void;
  debounceMs?: number;
}

export interface TokenDailyRefreshCoordinator {
  request(includeGrokHistory?: boolean): void;
  invalidate(): void;
  setStrongDemand(active: boolean): void;
  start(): () => void;
  reset(): void;
}

interface Flight {
  generation: number;
  strong: boolean;
}

interface QueuedRefresh {
  generation: number;
  strong: boolean;
}

export function createTokenDailyRefreshCoordinator(
  dependencies: CoordinatorDependencies,
): TokenDailyRefreshCoordinator {
  const debounceMs = dependencies.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let generation = 0;
  let preferredStrong = false;
  let flight: Flight | null = null;
  let queued: QueuedRefresh | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function queue(strong: boolean): void {
    queued = {
      generation,
      strong:
        strong ||
        (queued?.generation === generation ? queued.strong : false),
    };
  }

  function run(strong: boolean): void {
    const current: Flight = { generation, strong };
    flight = current;
    let read: Promise<TokenDailyRow[]>;
    try {
      read = strong
        ? dependencies.read({ includeGrokHistory: true })
        : dependencies.read();
    } catch (error) {
      finish(current, undefined, error);
      return;
    }
    void read.then(
      (rows) => finish(current, rows),
      (error: unknown) => finish(current, undefined, error),
    );
  }

  function finish(
    completed: Flight,
    rows?: TokenDailyRow[],
    error?: unknown,
  ): void {
    if (flight !== completed) return;
    flight = null;
    const next = queued?.generation === generation ? queued : null;
    if (queued === next) queued = null;

    if (completed.generation === generation && !next) {
      if (rows) dependencies.apply(rows);
      else if (error !== undefined) warnSafely();
    } else if (completed.generation === generation && error !== undefined) {
      warnSafely();
    }

    if (next) run(next.strong);
  }

  function warnSafely(): void {
    try {
      dependencies.warn?.();
    } catch {
      // Diagnostics must never alter refresh scheduling or store fencing.
    }
  }

  function request(includeGrokHistory = false): void {
    clearTimer();
    if (!flight) {
      run(includeGrokHistory);
      return;
    }
    if (
      flight.generation !== generation
    ) {
      queue(includeGrokHistory || preferredStrong || flight.strong);
    } else if (includeGrokHistory && !flight.strong) {
      queue(true);
    }
  }

  function invalidate(): void {
    clearTimer();
    if (flight) {
      queue(preferredStrong || flight.strong);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      request(preferredStrong);
    }, debounceMs);
  }

  function setStrongDemand(active: boolean): void {
    preferredStrong = active;
  }

  function start(): () => void {
    if (started) return () => undefined;
    started = true;
    generation += 1;
    unsubscribe = dependencies.subscribe?.(invalidate) ?? null;
    request(preferredStrong);
    const startedGeneration = generation;
    return () => {
      if (!started || startedGeneration !== generation) return;
      started = false;
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;
      queued = null;
      generation += 1;
    };
  }

  function reset(): void {
    clearTimer();
    unsubscribe?.();
    unsubscribe = null;
    started = false;
    generation += 1;
    preferredStrong = false;
    flight = null;
    queued = null;
  }

  return { request, invalidate, setStrongDemand, start, reset };
}

const tokenDailyCoordinator = createTokenDailyRefreshCoordinator({
  read: (options) =>
    options
      ? window.api.tokenUsageDaily(options)
      : window.api.tokenUsageDaily(),
  apply: (rows) => useTokenUsageStore.getState().setDaily(rows),
  subscribe: (listener) => window.api.onTokenUsageChanged(listener),
  warn: () => logger.warn('Daily usage refresh failed'),
});

export function requestTokenDailyRefresh(includeGrokHistory = false): void {
  tokenDailyCoordinator.request(includeGrokHistory);
}

let strongDemandOwners = 0;
export function retainStrongTokenDailyRefresh(): () => void {
  strongDemandOwners += 1;
  tokenDailyCoordinator.setStrongDemand(true);
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    strongDemandOwners = Math.max(0, strongDemandOwners - 1);
    tokenDailyCoordinator.setStrongDemand(strongDemandOwners > 0);
  };
}

export function startTokenDailyRefresh(): () => void {
  return tokenDailyCoordinator.start();
}

export function resetTokenDailyRefreshForTests(): void {
  strongDemandOwners = 0;
  tokenDailyCoordinator.reset();
}
