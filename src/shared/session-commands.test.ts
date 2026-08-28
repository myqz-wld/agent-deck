import { describe, expect, it } from 'vitest';
import {
  exactSessionCommand,
  matchingSessionCommands,
  normalizeSessionCommands,
  sessionCommandInvocation,
} from './session-commands';

describe('session commands', () => {
  it('bounds provider metadata and resolves canonical names and aliases', () => {
    const commands = normalizeSessionCommands([
      {
        name: '/compact',
        description: ' compress context ',
        argumentHint: '',
        aliases: ['shrink', '/shrink', 'shrink'],
      },
      { name: 'bad command', description: 'ignored' },
    ]);

    expect(commands).toEqual([{
      name: 'compact',
      description: 'compress context',
      argumentHint: '',
      aliases: ['shrink'],
    }]);
    expect(matchingSessionCommands(commands, '/shr')).toEqual(commands);
    expect(exactSessionCommand(commands, ' /shrink ')).toEqual(commands[0]);
    expect(exactSessionCommand(commands, '/compact now')).toBeNull();
    expect(sessionCommandInvocation(commands, '/shrink now')).toEqual(commands[0]);
    expect(sessionCommandInvocation(commands, '/unknown now')).toBeNull();
  });
});
