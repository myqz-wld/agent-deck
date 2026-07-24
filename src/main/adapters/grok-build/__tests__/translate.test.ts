import { describe, expect, it } from 'vitest';

import {
  beginGrokTurn,
  createGrokTranslationState,
  flushGrokTextUpdates,
  translateGrokTurnUsage,
  translateGrokUpdate,
  translateGrokUsage,
  waitForGrokStandardUsage,
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
    expect(started[1]?.payload).toMatchObject({ toolKind: 'edit' });
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

  it('maps Grok turn usage directly, deduplicates prompt_id, and keeps turns independent', () => {
    const state = createGrokTranslationState();
    const first = translateGrokTurnUsage(
      'app-session',
      null,
      {
        timestamp: 1_700_000_000,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-1',
          usage: {
            inputTokens: 621250,
            outputTokens: 2368,
            totalTokens: 623618,
            cachedReadTokens: 287833,
            reasoningTokens: 4,
            modelUsage: { 'claude-fable-5': {} },
          },
        },
      },
      state,
    );
    const duplicate = translateGrokTurnUsage(
      'app-session',
      null,
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-1',
          usage: { inputTokens: 999, outputTokens: 999 },
        },
      },
      state,
    );
    const second = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-2',
          usage: { inputTokens: 10, outputTokens: 7, cachedReadTokens: 2 },
        },
      },
      state,
    );
    expect(first?.payload).toMatchObject({
      messageId: 'prompt-1',
      model: 'claude-fable-5',
      inputTokens: 621250,
      outputTokens: 2368,
      reasoningTokens: 4,
      cacheReadTokens: 287833,
      cacheCreationTokens: 0,
    });
    expect(duplicate).toBeNull();
    expect(second?.payload).toMatchObject({
      messageId: 'prompt-2',
      model: 'grok-4.5',
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 2,
    });
  });

  it('carries extension usage into the cumulative standard usage baseline', () => {
    const state = createGrokTranslationState();
    expect(
      translateGrokTurnUsage(
        'app-session',
        'grok-4.5',
        {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-extension',
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          },
        },
        state,
      ),
    ).not.toBeNull();

    beginGrokTurn(state, 'app-session', 'grok-4.5');
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 21, inputTokens: 15, outputTokens: 6 },
      state,
    );

    expect(standard?.payload).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });

  it('falls back to extension metadata for prompt id and timestamp', () => {
    const state = createGrokTranslationState();
    const event = translateGrokTurnUsage(
      'app-session',
      null,
      {
        _meta: { promptId: 'meta-prompt', agentTimestampMs: 1_700_000_000_123 },
        update: {
          sessionUpdate: 'turn_completed',
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      },
      state,
    );

    expect(event).toMatchObject({
      ts: 1_700_000_000_123,
      payload: { messageId: 'meta-prompt', inputTokens: 1, outputTokens: 2 },
    });
  });

  it('prefers a late extension usage event over a standard response usage event', async () => {
    const state = createGrokTranslationState();
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5, thoughtTokens: 1 },
      state,
    );
    expect(standard).not.toBeNull();

    const fallback = waitForGrokStandardUsage(state, 1_000);
    const extension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-late',
          usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 },
        },
      },
      state,
    );

    expect(extension?.payload).toMatchObject({ messageId: 'prompt-late', outputTokens: 5 });
    await expect(fallback).resolves.toBe(false);
  });

  it('falls back to standard usage when no Grok extension event arrives', async () => {
    const state = createGrokTranslationState();
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    );
    expect(standard).not.toBeNull();

    await expect(waitForGrokStandardUsage(state, 0)).resolves.toBe(true);
    const lateExtension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-too-late',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );
    expect(lateExtension).toBeNull();
  });

  it('renders think tool calls as thinking events rather than tool cards', () => {
    const state = createGrokTranslationState();
    const started = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'think-1',
        title: 'think',
        kind: 'think',
        rawInput: { thought: 'checking the safest edit' },
      },
      state,
    );
    const completed = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'think-1',
        kind: 'think',
        status: 'completed',
      },
      state,
    );
    expect(started.map((event) => event.kind)).toEqual(['thinking']);
    expect(completed).toEqual([]);
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
