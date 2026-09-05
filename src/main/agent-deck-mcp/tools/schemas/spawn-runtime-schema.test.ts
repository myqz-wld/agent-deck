import { describe, expect, it } from 'vitest';

describe('spawn runtime schema', () => {
  it('schema exposes context mode, model, and thinking without changing omitted defaults', async () => {
    const { SPAWN_SESSION_MODEL_VALUES, SPAWN_SESSION_SCHEMA } = await import('./spawn');
    expect(SPAWN_SESSION_MODEL_VALUES).toEqual([
      'haiku',
      'sonnet',
      'opus',
      'fable',
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'grok-4.6',
      'grok-4.5',
    ]);
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('fable-5');
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('gpt-5.6');
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('gpt-5.5');
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('gpt-5.4');
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('deepseek-v4-pro[1m]');
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('deepseek-v4-pro');
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('deepseek-v4-flash');
    expect(SPAWN_SESSION_SCHEMA.model.unwrap().safeParse('claude-opus-4-8').success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.model.unwrap().safeParse('').success).toBe(false);
    expect(SPAWN_SESSION_SCHEMA.model.description).not.toContain('fable-5');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('gpt-6-astra');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('grok-4.6');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('grok-4.5');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('gpt-5.6-sol');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('gpt-5.6-terra');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('gpt-5.6-luna');
    expect(SPAWN_SESSION_SCHEMA.model.description).not.toContain('gpt-5.5');
    expect(SPAWN_SESSION_SCHEMA.model.description).not.toContain('gpt-5.4');
    expect(SPAWN_SESSION_SCHEMA.model.description).not.toContain('deepseek-v4-pro[1m]');
    expect(SPAWN_SESSION_SCHEMA.model.description).not.toContain('deepseek-v4-pro');
    expect(SPAWN_SESSION_SCHEMA.model.description).not.toContain('deepseek-v4-flash');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('Suggestions are not an allowlist');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain(
      'explicit model > resolved agent model > same-adapter source session > selected Gateway/native default',
    );
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('spawned session only');
    expect(SPAWN_SESSION_SCHEMA.thinking.unwrap().options).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(SPAWN_SESSION_SCHEMA.thinking.safeParse('minimal').success).toBe(false);
    expect(SPAWN_SESSION_SCHEMA.thinking.description).toContain(
      'explicit thinking > resolved agent effort > same-adapter source session > selected Gateway/native default',
    );
    expect(SPAWN_SESSION_SCHEMA.thinking.description).toContain(
      'Claude accepts low, medium, high, xhigh, and max',
    );
    expect(SPAWN_SESSION_SCHEMA.thinking.description).toContain(
      'Grok Build accepts low, medium, high, and xhigh',
    );
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse(undefined).success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse('fresh').success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse('fork').success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse('3').success).toBe(false);
    expect(SPAWN_SESSION_SCHEMA.contextMode.description).toContain('authenticated caller');
    expect(SPAWN_SESSION_SCHEMA.contextMode.description).toContain('same real directory');
    expect(SPAWN_SESSION_SCHEMA.contextMode.description).toContain('never silently downgrades');
    expect(SPAWN_SESSION_SCHEMA).toHaveProperty('gateway');
    expect(SPAWN_SESSION_SCHEMA).toHaveProperty('provider');
  });
});
