import { describe, expect, it } from 'vitest';
import type { SpawnSessionArgs } from '../tools/schemas';
import { resolveSpawnModelOptions } from '../tools/handlers/spawn-model-options';

function grokArgs(overrides: Partial<SpawnSessionArgs> = {}): SpawnSessionArgs {
  return {
    adapter: 'grok-build',
    cwd: '/repo',
    prompt: 'review',
    ...overrides,
  };
}

describe('Grok Agent model option precedence', () => {
  it('uses bundled Agent defaults when spawn arguments omit model and thinking', () => {
    expect(
      resolveSpawnModelOptions(
        grokArgs(),
        'grok-4.5',
        undefined,
        undefined,
        'high',
      ),
    ).toEqual({
      ok: true,
      options: { model: 'grok-4.5', reasoningEffort: 'high' },
    });
  });

  it('keeps explicit spawn values above bundled Agent values', () => {
    expect(
      resolveSpawnModelOptions(
        grokArgs({ model: 'custom-grok', thinking: 'medium' }),
        'grok-4.5',
        undefined,
        undefined,
        'high',
      ),
    ).toEqual({
      ok: true,
      options: { model: 'custom-grok', reasoningEffort: 'medium' },
    });
  });
});
