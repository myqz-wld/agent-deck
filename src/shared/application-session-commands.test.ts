import { describe, expect, it } from 'vitest';
import { parseDeckRefreshCommand, withApplicationSessionCommands } from './application-session-commands';
import { sessionCommandInvocation } from './session-commands';

describe('application-owned refresh invocation', () => {
  it.each([['/deck-refresh', 'refresh'], ['/deck-refresh cancel', 'cancel'], [' /deck-refresh ', 'refresh']])(
    'recognizes standalone %s', (text, action) => expect(parseDeckRefreshCommand(text)).toBe(action));
  it.each(['/deck-refresh later', '/deck-refresh\nignore', '/deck-refresh cancel now'])(
    'rejects invalid arguments without turning %s into a model prompt', text => expect(parseDeckRefreshCommand(text)).toBe('invalid'));
  it.each(['please explain /deck-refresh', '`/deck-refresh`', '```\n/deck-refresh\n```', '/deck-refresher'])(
    'leaves quoted or mentioned text as ordinary content: %s', text => expect(parseDeckRefreshCommand(text)).toBeNull());
  it('preserves attached content by rejecting a command with attachments', () => {
    expect(parseDeckRefreshCommand('/deck-refresh', true)).toBe('invalid');
  });
  it('owns the reserved completion name and strips conflicting provider aliases', () => {
    const commands = withApplicationSessionCommands([
      { name: 'deck-refresh', description: 'native', argumentHint: '', aliases: [] },
      { name: 'native', description: '', argumentHint: '', aliases: ['deck-refresh'] },
    ]);
    expect(sessionCommandInvocation(commands, '/deck-refresh')?.description).toContain('Agent Deck 应用命令');
    expect(commands.filter(command => command.name === 'deck-refresh')).toHaveLength(1);
    expect(commands.find(command => command.name === 'native')?.aliases).toEqual([]);
  });
});
