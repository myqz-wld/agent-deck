import type {
  ContextRuntimeIdentityResolution,
  ContextWindowObservation,
  ContextWindowObservationSource,
  ResolvedContextCapacity,
} from '@shared/types';

export const CONTEXT_WINDOW_OBSERVATION_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1_000;

const SOURCE_PRIORITY: Readonly<Record<ContextWindowObservationSource, number>> = {
  'effective-config': 1,
  'runtime-metadata': 2,
  'runtime-usage': 3,
};

export function contextWindowObservationSourcePriority(
  source: ContextWindowObservationSource,
): number {
  return SOURCE_PRIORITY[source];
}

/** Newer evidence wins; exact-time ties prefer authority, then the conservative smaller window. */
export function shouldReplaceContextWindowObservation(
  current: ContextWindowObservation,
  candidate: ContextWindowObservation,
): boolean {
  if (candidate.identity.runtimeKey !== current.identity.runtimeKey) return false;
  if (candidate.observedAt !== current.observedAt) {
    return candidate.observedAt > current.observedAt;
  }
  const candidatePriority = contextWindowObservationSourcePriority(candidate.source);
  const currentPriority = contextWindowObservationSourcePriority(current.source);
  if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;
  return candidate.windowTokens < current.windowTokens;
}

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
