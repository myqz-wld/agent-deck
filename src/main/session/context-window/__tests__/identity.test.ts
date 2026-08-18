import { describe, expect, it } from 'vitest';
import {
  createContextRuntimeIdentity,
  resolveContextRuntimeIdentity,
} from '../identity';

describe('context runtime identity', () => {
  it('builds a deterministic versioned key from exact trimmed runtime components', () => {
    const identity = createContextRuntimeIdentity({
      adapter: 'codex-cli',
      runtimeProvider: '  openai  ',
      model: '  gpt-5.6-codex  ',
      capacityConfigFingerprint: '  catalog-v4  ',
    });

    expect(identity).toEqual({
      version: 1,
      runtimeKey: JSON.stringify([
        'context-window-runtime',
        1,
        'codex-cli',
        'openai',
        'gpt-5.6-codex',
        'catalog-v4',
      ]),
      adapter: 'codex-cli',
      runtimeProvider: 'openai',
      model: 'gpt-5.6-codex',
      capacityConfigFingerprint: 'catalog-v4',
    });
  });

  it('keeps adapter, provider, model case, and capacity configuration in separate keys', () => {
    const base = {
      adapter: 'claude-code' as const,
      runtimeProvider: 'native',
      model: 'claude-sonnet-4-5',
    };
    const identities = [
      createContextRuntimeIdentity(base),
      createContextRuntimeIdentity({ ...base, runtimeProvider: 'gateway-a' }),
      createContextRuntimeIdentity({ ...base, model: 'Claude-Sonnet-4-5' }),
      createContextRuntimeIdentity({ ...base, capacityConfigFingerprint: 'override-64k' }),
      createContextRuntimeIdentity({ ...base, adapter: 'codex-cli' }),
    ];

    expect(new Set(identities.map((identity) => identity.runtimeKey))).toHaveLength(5);
  });

  it('returns explicit unavailable reasons instead of inventing default identities', () => {
    expect(
      resolveContextRuntimeIdentity({
        adapter: 'grok-build',
        runtimeProvider: null,
        model: 'grok-4',
      }),
    ).toEqual({ status: 'unavailable', reason: 'missing-runtime-provider' });
    expect(
      resolveContextRuntimeIdentity({
        adapter: 'claude-code',
        runtimeProvider: 'native',
        model: null,
      }),
    ).toEqual({ status: 'unavailable', reason: 'missing-model' });
    expect(
      resolveContextRuntimeIdentity({
        adapter: 'claude-code',
        runtimeProvider: 'native',
        model: 'sonnet',
        unavailableReason: 'unresolved-model-alias',
      }),
    ).toEqual({ status: 'unavailable', reason: 'unresolved-model-alias' });
  });

  it('rejects identities whose escaped runtime key cannot satisfy the durable schema bound', () => {
    expect(
      resolveContextRuntimeIdentity({
        adapter: 'codex-cli',
        runtimeProvider: '\u0000'.repeat(700),
        model: 'gpt-safe',
      }),
    ).toEqual({ status: 'unavailable', reason: 'invalid-runtime-identity' });

    expect(
      resolveContextRuntimeIdentity({
        adapter: 'codex-cli',
        runtimeProvider: 'openai',
        model: 'x'.repeat(1_025),
      }),
    ).toEqual({ status: 'unavailable', reason: 'invalid-runtime-identity' });
  });
});
