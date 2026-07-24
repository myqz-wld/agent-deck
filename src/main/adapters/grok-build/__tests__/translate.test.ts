import { describe, expect, it } from 'vitest';

import {
  createGrokTranslationState,
  flushGrokTextUpdates,
  translateGrokUpdate,
  translateGrokUsage,
} from '../translate';

describe('Grok ACP event translation', () => {
  it('maps text, thought, tool, diff, and plan updates', () => {
    const state = createGrokTranslationState();
    expect(translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hel' },
      },
      state,
    )).toEqual([]);
    expect(translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'lo' },
      },
      state,
    )).toEqual([]);
    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'reasoning' },
        },
        state,
      )[0],
    ).toMatchObject({ kind: 'message', payload: { text: 'hello' } });

    const started = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Edit',
        kind: 'edit',
        status: 'in_progress',
      },
      state,
    );
    expect(started.map((event) => event.kind)).toEqual([
      'thinking',
      'tool-use-start',
    ]);
    const completed = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'src/a.ts',
            oldText: 'old',
            newText: 'new',
          },
        ],
      },
      state,
    );
    expect(completed.map((event) => event.kind)).toEqual([
      'tool-use-end',
      'file-changed',
    ]);
  });

  it('coalesces contiguous ACP chunks into one persisted bubble', () => {
    const state = createGrokTranslationState();
    for (const text of ['one', ' ', 'message']) {
      expect(translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
        state,
      )).toEqual([]);
    }
    expect(flushGrokTextUpdates('app-session', state)).toMatchObject([
      { kind: 'message', payload: { text: 'one message', role: 'assistant' } },
    ]);
    expect(flushGrokTextUpdates('app-session', state)).toEqual([]);
  });

  it('separates consecutive ACP messages by messageId', () => {
    const state = createGrokTranslationState();
    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: 'first' },
        },
        state,
      ),
    ).toEqual([]);
    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-2',
          content: { type: 'text', text: 'second' },
        },
        state,
      ),
    ).toMatchObject([{ kind: 'message', payload: { text: 'first' } }]);
    expect(flushGrokTextUpdates('app-session', state)).toMatchObject([
      { kind: 'message', payload: { text: 'second' } },
    ]);
  });

  it('emits cumulative usage as non-negative deltas', () => {
    const state = createGrokTranslationState();
    const first = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5, thoughtTokens: 2 },
      state,
    );
    const second = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 23, inputTokens: 15, outputTokens: 8, thoughtTokens: 4 },
      state,
    );
    expect(first?.payload).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
    });
    expect(second?.payload).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it('does not persist returned image base64 in event payloads', () => {
    const state = createGrokTranslationState();
    const [event] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          data: 'aGVsbG8=',
          mimeType: 'image/png',
        },
      },
      state,
    );
    expect(JSON.stringify(event)).not.toContain('aGVsbG8=');
    expect(event).toMatchObject({
      kind: 'message',
      payload: { image: { mime: 'image/png', byteLength: 6 } },
    });
  });
});
