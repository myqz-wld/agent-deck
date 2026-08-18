import type {
  ContextRuntimeIdentityResolution,
  ContextWindowObservation,
  ResolvedContextCapacity,
} from '@shared/types';

export const CONTEXT_WINDOW_OBSERVATION_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1_000;

function freshUntil(observedAt: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    observedAt + CONTEXT_WINDOW_OBSERVATION_FRESHNESS_MS,
  );
}

export function resolveContextCapacity(
  identity: ContextRuntimeIdentityResolution,
  observation: ContextWindowObservation | null,
  now: number,
): ResolvedContextCapacity {
  if (identity.status === 'unavailable') {
    return {
      status: 'unknown',
      identity: null,
      windowTokens: null,
      reason: identity.reason,
    };
  }
  if (!observation || observation.identity.runtimeKey !== identity.identity.runtimeKey) {
    return {
      status: 'unknown',
      identity: identity.identity,
      windowTokens: null,
      reason: 'no-observation',
    };
  }
  const expiresAt = freshUntil(observation.observedAt);
  if (now > expiresAt) {
    return {
      status: 'stale',
      identity: identity.identity,
      windowTokens: null,
      observation,
      freshUntil: expiresAt,
    };
  }
  return {
    status: 'observed',
    identity: identity.identity,
    windowTokens: observation.windowTokens,
    source: observation.source,
    observedAt: observation.observedAt,
    freshUntil: expiresAt,
  };
}
