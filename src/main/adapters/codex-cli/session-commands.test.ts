import { describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './adapter-core';
import {
  listCodexSessionCommands,
  parseCodexHostSessionCommand,
} from './session-commands';

describe('Codex host session commands', () => {
  it('advertises and recognizes only faithfully hosted commands', () => {
    expect(listCodexSessionCommands().map((command) => command.name))
      .toEqual(['clear', 'compact']);
    expect(parseCodexHostSessionCommand('/clear')).toBe('clear');
    expect(parseCodexHostSessionCommand(' /compact ')).toBe('compact');
    expect(parseCodexHostSessionCommand('/review')).toBeNull();
    expect(parseCodexHostSessionCommand('/compact now')).toBeNull();
  });

  it('routes exact human commands to the control boundary instead of the model queue', async () => {
    const executeSessionCommand = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    const adapter = new CodexCliAdapter({} as never);
    adapter.bridge = { executeSessionCommand, sendMessage } as never;

    await adapter.sendMessage('session-a', '/compact');
    await adapter.sendMessage('session-a', '/review');

    expect(executeSessionCommand).toHaveBeenCalledWith('session-a', 'compact');
    expect(sendMessage).toHaveBeenCalledWith('session-a', '/review', undefined, undefined);
  });
});
