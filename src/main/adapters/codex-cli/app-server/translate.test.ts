import { describe, expect, it } from 'vitest';
import type { CodexAppServerNotification } from './client';

import { translateCodexAppServerNotification } from './translate';

function collect() {
  const events: { kind: string; payload: unknown }[] = [];
  return {
    emit: (kind: string, payload: unknown) => events.push({ kind, payload }),
    events,
  };
}

describe('translateCodexAppServerNotification', () => {
  it('keeps transient app-server stream errors open and finishes fatal stream errors', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'error',
        params: { willRetry: true, error: { message: 'Reconnecting... 2/5' } },
      } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      {
        method: 'error',
        params: { willRetry: false, error: { message: 'JSON parse failed' } },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      { kind: 'message', payload: { text: '🔄 Codex 正在重连... 重连尝试 2/5' } },
      { kind: 'message', payload: { text: '⚠ Codex 流级错误：JSON parse failed', error: true } },
      { kind: 'finished', payload: { ok: false, subtype: 'error' } },
    ]);
  });

  it('classifies context overflow only from the structured native error code', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification({
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: {
            message: 'too many tokens',
            codexErrorInfo: 'contextWindowExceeded',
          },
        },
      },
    } as CodexAppServerNotification, emit);
    translateCodexAppServerNotification({
      method: 'error',
      params: {
        willRetry: false,
        error: {
          message: 'native overflow',
          codexErrorInfo: 'contextWindowExceeded',
        },
      },
    } as CodexAppServerNotification, emit);
    translateCodexAppServerNotification({
      method: 'error',
      params: {
        willRetry: false,
        error: { message: 'text mentions contextWindowExceeded only' },
      },
    } as CodexAppServerNotification, emit);

    expect(events.filter((event) => event.kind === 'finished')).toEqual([
      {
        kind: 'finished',
        payload: {
          ok: false,
          subtype: 'failed',
          failureReason: 'context-window-exceeded',
        },
      },
      {
        kind: 'finished',
        payload: {
          ok: false,
          subtype: 'error',
          failureReason: 'context-window-exceeded',
        },
      },
      { kind: 'finished', payload: { ok: false, subtype: 'error' } },
    ]);
  });

  it('skips empty assistant-visible app-server message items', () => {
    const { emit, events } = collect();

    for (const item of [
      { id: 'agent-empty', type: 'agentMessage' },
      { id: 'agent-blank', type: 'agentMessage', text: '' },
      { id: 'plan-blank', type: 'plan', text: '   ' },
    ]) {
      translateCodexAppServerNotification(
        { method: 'item/completed', params: { item } } as CodexAppServerNotification,
        emit,
      );
    }

    expect(events).toEqual([]);
  });

  it('keeps non-empty assistant-visible app-server message items', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'agent-text', type: 'agentMessage', text: 'done' } },
      } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'plan-text', type: 'plan', text: '1. check\n2. fix' } },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      { kind: 'message', payload: { text: 'done', role: 'assistant' } },
      { kind: 'message', payload: { text: '1. check\n2. fix', role: 'assistant' } },
    ]);
  });

  it('normalizes skill dynamic tool calls to the existing Skill renderer contract', () => {
    const { emit, events } = collect();
    const item = {
      id: 'dyn-1',
      type: 'dynamicToolCall',
      namespace: 'skills',
      tool: 'invoke',
      arguments: { skill: 'prompt-asset-improver', args: 'audit durable prompts' },
      contentItems: [{ type: 'text', text: 'done' }],
      durationMs: 320,
      status: 'completed',
      success: true,
    };

    translateCodexAppServerNotification(
      { method: 'item/started', params: { item } } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      { method: 'item/completed', params: { item } } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'Skill',
          toolInput: { skill: 'prompt-asset-improver', args: 'audit durable prompts' },
          toolUseId: 'dyn-1',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'dyn-1',
          toolName: 'Skill',
          toolResult: [{ type: 'text', text: 'done' }],
          durationMs: 320,
          status: 'completed',
          error: undefined,
        },
      },
    ]);
  });

  it('keeps non-skill dynamic tool calls as namespaced dynamic tools', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/started',
        params: {
          item: {
            id: 'dyn-2',
            type: 'dynamicToolCall',
            namespace: 'browser',
            tool: 'open',
            arguments: { url: 'https://example.test' },
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'browser.open',
          toolInput: { url: 'https://example.test' },
          toolUseId: 'dyn-2',
        },
      },
    ]);
  });

  it('keeps structured MCP results and provider duration metadata', () => {
    const { emit, events } = collect();
    const item = {
      id: 'mcp-1',
      type: 'mcpToolCall',
      server: 'agent-deck',
      tool: 'spawn_session',
      arguments: { prompt: 'review' },
      result: {
        content: [],
        structuredContent: { sessionId: 'child-1', spawnPromptMessageId: 'msg-1' },
        _meta: { trace: 'safe' },
      },
      error: null,
      durationMs: 240,
      status: 'completed',
    };

    translateCodexAppServerNotification(
      { method: 'item/started', params: { item } } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      { method: 'item/completed', params: { item } } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'mcp__agent-deck__spawn_session',
          toolInput: { prompt: 'review' },
          toolUseId: 'mcp-1',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'mcp-1',
          toolName: 'mcp__agent-deck__spawn_session',
          toolResult: item.result,
          error: undefined,
          durationMs: 240,
          status: 'completed',
        },
      },
    ]);
  });

  it('renders standalone web-search results and clock sleep items', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'search-1',
            type: 'webSearch',
            query: 'Agent Deck',
            action: { type: 'search', queries: ['Agent Deck'] },
            results: [{ title: 'Agent Deck', url: 'https://example.test' }],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      {
        method: 'item/started',
        params: { item: { id: 'sleep-1', type: 'sleep', durationMs: 1250 } },
      } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'sleep-1', type: 'sleep', durationMs: 1250 } },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'WebSearch',
          toolInput: { query: 'Agent Deck' },
          toolUseId: 'search-1',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'search-1',
          toolName: 'WebSearch',
          toolResult: {
            query: 'Agent Deck',
            action: { type: 'search', queries: ['Agent Deck'] },
            results: [{ title: 'Agent Deck', url: 'https://example.test' }],
          },
          status: 'completed',
        },
      },
      {
        kind: 'tool-use-start',
        payload: {
          toolUseId: 'sleep-1',
          toolName: 'clock.sleep',
          toolInput: { durationMs: 1250 },
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'sleep-1',
          toolName: 'clock.sleep',
          toolInput: { durationMs: 1250 },
          durationMs: 1250,
          status: 'completed',
        },
      },
    ]);
  });

  it('passes image display bytes and paths to the ingest media store', () => {
    const { emit, events } = collect();
    for (const item of [
      { id: 'view-1', type: 'imageView', path: '/repo/reference.png' },
      {
        id: 'generate-1',
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: 'compact dashboard',
        result: 'large-base64-payload',
        savedPath: '/repo/generated.png',
      },
    ]) {
      translateCodexAppServerNotification(
        { method: 'item/completed', params: { item } } as CodexAppServerNotification,
        emit,
      );
    }

    expect(events).toEqual([
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'view-1',
          toolName: 'ImageView',
          toolInput: { path: '/repo/reference.png' },
          toolResult: { path: '/repo/reference.png' },
          imageInputs: [{ kind: 'path', path: '/repo/reference.png' }],
          status: 'completed',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'generate-1',
          toolName: 'ImageGeneration',
          toolInput: { prompt: 'compact dashboard' },
          toolResult: { savedPath: '/repo/generated.png', hasInlineResult: true },
          imageInputs: [{ data: 'large-base64-payload', fallbackPath: '/repo/generated.png' }],
          status: 'completed',
          error: undefined,
        },
      },
    ]);
    // prepareEventImages owns persistence and removes transient bytes before event history/IPC.
    expect(JSON.stringify(events[1].payload)).toContain('large-base64-payload');
  });
});
