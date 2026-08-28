import { describe, expect, it, vi } from 'vitest';
import { listClaudeSessionCommands } from './session-commands';

describe('Claude session command catalog', () => {
  it('merges discovered commands with explicit lifecycle fallbacks', async () => {
    const commands = await listClaudeSessionCommands({
      supportedCommands: vi.fn(async () => [{
        name: 'review', description: 'Review changes', argumentHint: '<scope>', aliases: [],
      }]),
    });

    expect(commands.map((command) => command.name)).toEqual(['review', 'clear', 'compact']);
  });

  it('keeps clear and compact when SDK discovery fails', async () => {
    const commands = await listClaudeSessionCommands({
      supportedCommands: vi.fn(async () => { throw new Error('transport down'); }),
    });
    expect(commands.map((command) => command.name)).toEqual(['clear', 'compact']);
  });
});
