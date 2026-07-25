import { describe, expect, it } from 'vitest';
import { SPAWN_SESSION_SCHEMA } from '../tools/schemas';

describe('spawn_session agentName schema', () => {
  it('accepts direct and Plugin-qualified Agent selectors', () => {
    expect(SPAWN_SESSION_SCHEMA.agentName.safeParse('reviewer-claude').success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.agentName.safeParse('demo-plugin:reviewer').success).toBe(true);
  });

  it('rejects UI labels and selectors with multiple qualifiers', () => {
    expect(SPAWN_SESSION_SCHEMA.agentName.safeParse('demo:reviewer:extra').success).toBe(false);
    expect(SPAWN_SESSION_SCHEMA.agentName.safeParse('plugin:demo/reviewer').success).toBe(false);
  });

  it('documents the Codex Plugin Agent extension boundary', () => {
    expect(SPAWN_SESSION_SCHEMA.agentName.description).toContain('agents/*.toml extension');
  });
});
