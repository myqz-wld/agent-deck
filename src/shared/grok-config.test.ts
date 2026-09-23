import { describe, expect, it } from 'vitest';
import { readGrokModelDefaults } from './grok-config';

describe('native Grok model defaults', () => {
  it('reads the native table and dotted-key forms without selecting custom profiles', () => {
    for (const config of [
      '[models]\ndefault = "grok-build"\ndefault_reasoning_effort = "medium"',
      "models.default = 'grok-build'\nmodels.default_reasoning_effort = 'medium'",
    ]) {
      expect(readGrokModelDefaults(`${config}\n[model.other]\nmodel = "other"`)).toEqual({
        model: 'grok-build', thinking: 'medium',
      });
    }
  });

  it('does not invent a default or interpret obsolete top-level fields', () => {
    for (const config of [null, '', 'invalid =', 'models = 42',
      'model = "legacy"\nreasoning_effort = "low"', '[models]\ndefault = ""']) {
      expect(readGrokModelDefaults(config)).toEqual({ model: null, thinking: null });
    }
  });
});
