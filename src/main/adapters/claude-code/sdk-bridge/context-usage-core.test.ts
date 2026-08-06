import { describe, expect, it } from 'vitest';

import {
  claudeAssistantContextTokens,
  claudeContextUsagePayload,
  claudeContextWindowObservation,
  claudeContextWindowPayload,
} from './context-usage-core';
import { makeInternalSession } from './types';

describe('Claude context usage Core', () => {
  it('sums exact non-negative assistant context counters', () => {
    expect(
      claudeAssistantContextTokens({
        input_tokens: 10.9,
        output_tokens: 2.2,
        cache_creation_input_tokens: 3.8,
        cache_read_input_tokens: 4.7,
      }),
    ).toBe(19);
    expect(claudeAssistantContextTokens({ input_tokens: 1 })).toBeNull();
    expect(
      claudeAssistantContextTokens({ input_tokens: -1, output_tokens: 2 }),
    ).toBeNull();
  });

  it('adds runtime identity only for a concrete provider model', () => {
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
      runtimeProvider: 'claude-code',
    });
    internal.runtimeModel = 'claude-opus-4-8';

    expect(claudeContextUsagePayload(internal, { usedTokens: 12 })).toEqual({
      usedTokens: 12,
      runtimeIdentity: {
        runtimeProvider: 'claude-code',
        model: 'claude-opus-4-8',
      },
    });
    expect(
      claudeContextUsagePayload(internal, { usedTokens: 12 }, 'opus'),
    ).toEqual({ usedTokens: 12 });
  });

  it('maps one Gateway alias entry to the exact initialized primary model', () => {
    expect(
      claudeContextWindowObservation(
        {
          opus: { contextWindow: 200_000 },
          'claude-haiku-4-5': { contextWindow: 128_000 },
        },
        'gateway-opus-exact',
        { opus: 'gateway-opus-exact' },
      ),
    ).toEqual({ model: 'gateway-opus-exact', windowTokens: 200_000 });
  });

  it('rejects alias-only, missing, invalid, and ambiguous primary attribution', () => {
    expect(
      claudeContextWindowObservation({ opus: { contextWindow: 200_000 } }, 'opus'),
    ).toBeNull();
    expect(
      claudeContextWindowObservation({ opus: { contextWindow: 0 } }, 'claude-opus-4-8'),
    ).toBeNull();
    expect(
      claudeContextWindowObservation(
        {
          opus: { contextWindow: 200_000 },
          'claude-opus': { contextWindow: 1_000_000 },
        },
        'gateway-opus-exact',
        { opus: 'gateway-opus-exact' },
      ),
    ).toBeNull();
  });

  it('projects a finalized runtime window through the initialized identity', () => {
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-b',
      runtimeProvider: 'claude-code',
    });
    internal.runtimeModel = 'claude-sonnet-4-6';

    expect(
      claudeContextWindowPayload(internal, {
        'claude-sonnet-4-6': { contextWindow: 1_000_000 },
        'claude-haiku-4-5': { contextWindow: 128_000 },
      }),
    ).toEqual({
      windowTokens: 1_000_000,
      capacitySource: 'runtime-usage',
      runtimeIdentity: {
        runtimeProvider: 'claude-code',
        model: 'claude-sonnet-4-6',
      },
    });
  });
});
