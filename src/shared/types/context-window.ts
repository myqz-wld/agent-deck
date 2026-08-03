import type { SessionAdapterId } from './session';

/** Native evidence source, ordered from weakest to strongest for exact-timestamp conflicts. */
export type ContextWindowObservationSource =
  | 'effective-config'
  | 'runtime-metadata'
  | 'runtime-usage';

/** Exact provider runtime identity. Aliases are not concrete unless an adapter resolves them. */
export interface ContextRuntimeIdentity {
  version: 1;
  runtimeKey: string;
  adapter: SessionAdapterId;
  runtimeProvider: string;
  model: string;
  capacityConfigFingerprint: string;
}

export type ContextRuntimeIdentityUnavailableReason =
  | 'missing-runtime-provider'
  | 'missing-model'
  | 'unresolved-model-alias'
  | 'ambiguous-model'
  | 'unsupported-runtime';

export type ContextRuntimeIdentityResolution =
  | { status: 'concrete'; identity: ContextRuntimeIdentity }
  | { status: 'unavailable'; reason: ContextRuntimeIdentityUnavailableReason };

export interface ContextWindowObservation {
  identity: ContextRuntimeIdentity;
  windowTokens: number;
  source: ContextWindowObservationSource;
  observedAt: number;
  originSessionId: string | null;
}

export type ContextCapacityUnknownReason =
  | ContextRuntimeIdentityUnavailableReason
  | 'no-observation';

/** Capacity stays tagged so stale or unknown values cannot be consumed as trusted token counts. */
export type ResolvedContextCapacity =
  | {
      status: 'observed';
      identity: ContextRuntimeIdentity;
      windowTokens: number;
      source: ContextWindowObservationSource;
      observedAt: number;
      freshUntil: number;
    }
  | {
      status: 'stale';
      identity: ContextRuntimeIdentity;
      windowTokens: null;
      observation: ContextWindowObservation;
      freshUntil: number;
    }
  | {
      status: 'unknown';
      identity: ContextRuntimeIdentity | null;
      windowTokens: null;
      reason: ContextCapacityUnknownReason;
    };
