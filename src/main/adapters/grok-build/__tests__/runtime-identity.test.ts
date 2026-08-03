import { describe, expect, it } from 'vitest';

import type { GrokCreateOpts } from '@main/adapters/types';
import { createGrokRuntime } from '../runtime-factory';
import {
  applyGrokNegotiatedModel,
  grokRuntimeIdentity,
} from '../runtime-identity';

function runtime(model?: string) {
  return createGrokRuntime(
    'app-session',
    { cwd: '/repo', ...(model ? { model } : {}) } as GrokCreateOpts,
    null,
  );
}

describe('Grok native runtime identity', () => {
  it('attributes the trimmed ACP model separately from the request alias', () => {
    const active = runtime('grok-latest');
    active.nativeDefaultModel = 'grok-default';

    applyGrokNegotiatedModel(active, '  grok-4.5  ');

    expect(active).toMatchObject({
      model: 'grok-latest',
      modelOverride: 'grok-latest',
      runtimeIdentity: {
        runtimeProvider: 'native',
        model: 'grok-4.5',
      },
    });
  });

  it('does not attribute an unconfirmed requested model', () => {
    const active = runtime('requested-alias');
    active.nativeDefaultModel = 'grok-4.5';

    applyGrokNegotiatedModel(active, null);

    expect(active.model).toBe('requested-alias');
    expect(active.runtimeIdentity).toBeNull();
  });

  it('attributes the ACP initialize default only when model selection is delegated', () => {
    const active = runtime();
    active.nativeDefaultModel = 'grok-4.5';

    applyGrokNegotiatedModel(active, null);

    expect(active.model).toBe('grok-4.5');
    expect(active.runtimeIdentity).toEqual({
      runtimeProvider: 'native',
      model: 'grok-4.5',
    });
  });

  it('rejects blank native model evidence', () => {
    expect(grokRuntimeIdentity('   ')).toBeNull();
  });
});
