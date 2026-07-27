import { describe, expect, it } from 'vitest';

import { filterAgentDeckTools } from '../tool-policy';
import {
  SPAWN_SESSION_SCHEMA,
  spawnSessionSchemaForCaller,
} from '../tools/schemas/spawn';

describe('Agent Deck MCP adapter tool policy', () => {
  const tools = [
    { name: 'list_sessions' },
    { name: 'spawn_session' },
    { name: 'present_plan' },
  ];

  it('preserves the complete tool surface for full profiles', () => {
    expect(filterAgentDeckTools(tools, { kind: 'all' })).toEqual(tools);
  });

  it('does not expose tools omitted by a limited profile', () => {
    expect(
      filterAgentDeckTools(tools, {
        kind: 'allow',
        tools: ['list_sessions'],
      }),
    ).toEqual([{ name: 'list_sessions' }]);
  });

  it('removes impossible native fork input for a non-forking caller profile', () => {
    const limited = spawnSessionSchemaForCaller(false);
    const full = spawnSessionSchemaForCaller(true);
    expect(limited.contextMode.safeParse('fork').success).toBe(false);
    expect(limited.contextMode.safeParse('fresh').success).toBe(true);
    expect(full.contextMode.safeParse('fork').success).toBe(true);
  });

  it.each(['dontAsk', 'auto'] as const)(
    'accepts the current Claude permission mode %s in spawn_session',
    (mode) => {
      expect(SPAWN_SESSION_SCHEMA.permissionMode.safeParse(mode).success).toBe(true);
    },
  );
});
