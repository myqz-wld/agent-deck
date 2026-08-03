import { createContextRuntimeIdentity } from '@main/session/context-window/identity';
import type {
  ResolvedContextCapacity,
  SessionAdapterId,
} from '@shared/types';

export function unknownContextCapacity(
  reason: Extract<ResolvedContextCapacity, { status: 'unknown' }>['reason'] = 'no-observation',
): ResolvedContextCapacity {
  return { status: 'unknown', identity: null, windowTokens: null, reason };
}

export function observedContextCapacity(
  windowTokens: number,
  input: {
    adapter?: SessionAdapterId;
    runtimeProvider?: string;
    model?: string;
    observedAt?: number;
  } = {},
): ResolvedContextCapacity {
  const observedAt = input.observedAt ?? 1_000;
  return {
    status: 'observed',
    identity: createContextRuntimeIdentity({
      adapter: input.adapter ?? 'claude-code',
      runtimeProvider: input.runtimeProvider ?? 'native',
      model: input.model ?? 'test-model',
    }),
    windowTokens,
    source: 'runtime-usage',
    observedAt,
    freshUntil: observedAt + 7 * 24 * 60 * 60 * 1_000,
  };
}

export function staleContextCapacity(
  windowTokens = 128_000,
): ResolvedContextCapacity {
  const identity = createContextRuntimeIdentity({
    adapter: 'claude-code',
    runtimeProvider: 'native',
    model: 'stale-model',
  });
  return {
    status: 'stale',
    identity,
    windowTokens: null,
    observation: {
      identity,
      windowTokens,
      source: 'runtime-usage',
      observedAt: 1,
      originSessionId: null,
    },
    freshUntil: 1 + 7 * 24 * 60 * 60 * 1_000,
  };
}
