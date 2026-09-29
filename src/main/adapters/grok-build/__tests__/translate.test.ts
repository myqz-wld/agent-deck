import { describe, expect, it } from 'vitest';

import { createGrokTranslationState, flushGrokTextUpdates, translateGrokUpdate } from '../translate';

describe('Grok ACP event translation', () => {
  it('maps ACP current-context usage without treating it as cumulative token usage', () => {
    const [event] = translateGrokUpdate(
      'app-session',
      '/repo',
      { sessionUpdate: 'usage_update', used: 65_432, size: 131_072 },
      createGrokTranslationState(),
      { runtimeProvider: 'native', model: 'grok-4.5' },
    );

    expect(event).toMatchObject({
      kind: 'context-usage',
      payload: {
        usedTokens: 65_432,
        windowTokens: 131_072,
        runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
        capacitySource: 'runtime-usage',
      },
    });
  });

  it('keeps unattributed ACP usage session-scoped and non-authoritative', () => {
    const [event] = translateGrokUpdate(
      'app-session',
      '/repo',
      { sessionUpdate: 'usage_update', used: 10, size: 20 },
      createGrokTranslationState(),
      null,
    );

    expect(event?.payload).toEqual({ usedTokens: 10, windowTokens: 20 });
  });

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
    expect(completed[0]?.payload).toMatchObject({
      toolName: 'Edit',
      status: 'completed',
    });
  });

  it('keeps one stable tool name when ACP updates the human-readable title', () => {
    const state = createGrokTranslationState();
    const [started] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-title-patch',
        title: 'run_terminal_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'pnpm test' },
      },
      state,
    );
    const [completed] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-title-patch',
        title: 'Finished running pnpm test',
        status: 'completed',
        rawOutput: 'ok',
      },
      state,
    );

    expect(started).toMatchObject({
      kind: 'tool-use-start',
      payload: { toolName: 'run_terminal_command', status: 'inProgress' },
    });
    expect(completed).toMatchObject({
      kind: 'tool-use-end',
      payload: { toolName: 'run_terminal_command', status: 'completed' },
    });
  });

  it('prefers the ACP programmatic name and preserves canonical failed status', () => {
    const state = createGrokTranslationState();
    const [started] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-programmatic-name',
        name: 'search_tool',
        title: 'Searching the repository',
        kind: 'search',
        status: 'in_progress',
        rawInput: { pattern: 'toolName' },
      },
      state,
    );
    const [failed] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-programmatic-name',
        name: 'search_tool',
        title: 'Repository search failed',
        status: 'failed',
        rawOutput: 'search unavailable',
      },
      state,
    );

    expect(started).toMatchObject({
      kind: 'tool-use-start',
      payload: { toolName: 'search_tool', toolKind: 'search' },
    });
    expect(failed).toMatchObject({
      kind: 'tool-use-end',
      payload: { toolName: 'search_tool', toolKind: 'search', status: 'failed' },
    });
  });

  it('closes an ACP tool_call that arrives in a terminal state without waiting for an update', () => {
    const state = createGrokTranslationState();
    const events = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-already-complete',
        name: 'fast_tool',
        title: 'Fast tool',
        kind: 'execute',
        status: 'completed',
        rawInput: { value: 1 },
        rawOutput: { ok: true },
      },
      state,
    );

    expect(events).toMatchObject([
      {
        kind: 'tool-use-start',
        payload: { toolUseId: 'tool-already-complete', status: 'completed' },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'tool-already-complete',
          status: 'completed',
          toolResult: { ok: true },
        },
      },
    ]);
    expect(state.startedToolIds.has('tool-already-complete')).toBe(false);
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

  it('passes returned image bytes to the ingest media store', () => {
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
    expect(event).toMatchObject({
      kind: 'message',
      payload: { image: { mime: 'image/png', byteLength: 6 },
        imageInputs: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] },
    });
  });
});
