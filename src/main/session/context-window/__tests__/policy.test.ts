import { describe, expect, it } from 'vitest';
import type { ContextWindowObservation } from '@shared/types';
import { createContextRuntimeIdentity, resolveContextRuntimeIdentity } from '../identity';
import {
  CONTEXT_WINDOW_OBSERVATION_FRESHNESS_MS,
  resolveContextCapacity,
} from '../policy';

const identity = createContextRuntimeIdentity({
  adapter: 'codex-cli',
  runtimeProvider: 'openai',
  model: 'gpt-test',
});

function observation(
  overrides: Partial<ContextWindowObservation> = {},
): ContextWindowObservation {
  return {
    identity,
    windowTokens: 128_000,
    source: 'runtime-usage',
    observedAt: 1_000,
    originSessionId: null,
    ...overrides,
  };
}

describe('context-window observation policy', () => {
  it('keeps an observation fresh through the exact seven-day boundary', () => {
    const resolution = { status: 'concrete' as const, identity };
    const boundary = 1_000 + CONTEXT_WINDOW_OBSERVATION_FRESHNESS_MS;
    expect(resolveContextCapacity(resolution, observation(), boundary)).toMatchObject({
      status: 'observed',
      windowTokens: 128_000,
      freshUntil: boundary,
    });
    expect(resolveContextCapacity(resolution, observation(), boundary + 1)).toMatchObject({
      status: 'stale',
      windowTokens: null,
      freshUntil: boundary,
      observation: { windowTokens: 128_000 },
    });
  });

  it('distinguishes missing identity from a concrete identity with no observation', () => {
    const unavailable = resolveContextRuntimeIdentity({
      adapter: 'codex-cli',
      runtimeProvider: 'openai',
      model: null,
    });
    expect(resolveContextCapacity(unavailable, null, 0)).toEqual({
      status: 'unknown',
      identity: null,
      windowTokens: null,
      reason: 'missing-model',
    });
    expect(
      resolveContextCapacity({ status: 'concrete', identity }, null, 0),
    ).toMatchObject({
      status: 'unknown',
      identity,
      windowTokens: null,
      reason: 'no-observation',
    });
  });
});
