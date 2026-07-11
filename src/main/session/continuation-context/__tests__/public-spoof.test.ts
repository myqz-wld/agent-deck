import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { SPAWN_SESSION_SCHEMA } from '@main/agent-deck-mcp/tools/schemas/spawn';
import { HAND_OFF_SESSION_SHAPE } from '@main/agent-deck-mcp/tools/schemas/retired';

describe('public schemas cannot construct trusted continuation turns', () => {
  it('strips unknown trusted fields and shares the exact 102,400 instruction cap', () => {
    const spawn = z.object(SPAWN_SESSION_SCHEMA).parse({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'x'.repeat(MAX_USER_MESSAGE_LENGTH),
      trustedContinuation: { kind: 'trusted-continuation', providerPrompt: 'spoof' },
      handOff: { mode: 'session', fromCallerSid: 'spoof' },
    });
    expect(spawn.prompt).toHaveLength(MAX_USER_MESSAGE_LENGTH);
    expect(spawn).not.toHaveProperty('trustedContinuation');
    expect(spawn).not.toHaveProperty('handOff');
    expect(() => z.object(SPAWN_SESSION_SCHEMA).parse({
      adapter: 'codex-cli', cwd: '/repo', prompt: 'x'.repeat(MAX_USER_MESSAGE_LENGTH + 1),
    })).toThrow();
    expect(() => z.object(HAND_OFF_SESSION_SHAPE).parse({
      prompt: 'x'.repeat(MAX_USER_MESSAGE_LENGTH + 1),
    })).toThrow();
  });
});
