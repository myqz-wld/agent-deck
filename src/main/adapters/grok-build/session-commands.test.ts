import { describe, expect, it } from 'vitest';
import { commandsFromGrokUpdate } from './session-commands';

describe('Grok ACP session command catalog', () => {
  it('maps replace-all available command metadata', () => {
    expect(commandsFromGrokUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{
        name: 'research_codebase',
        description: 'Research the repository',
        input: { hint: '<question>' },
      }],
    })).toEqual([{
      name: 'research_codebase',
      description: 'Research the repository',
      argumentHint: '<question>',
      aliases: [],
    }]);
  });
});
