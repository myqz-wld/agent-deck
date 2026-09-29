import { describe, expect, it } from 'vitest';
import type { CodexAppServerNotification } from './client';

import { createCodexAppServerTranslateState, translateCodexAppServerNotification } from './translate';

function collect() {
  const events: { kind: string; payload: unknown }[] = [];
  return {
    emit: (kind: string, payload: unknown) => events.push({ kind, payload }),
    events,
  };
}

describe('translateCodexAppServerNotification', () => {
  it('emits only app-server reasoning summaries as thinking blocks', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            content: ['raw reasoning content'],
            summary: ['safe reasoning summary'],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      { kind: 'thinking', payload: { text: 'safe reasoning summary' } },
    ]);
  });

  it('does not render app-server reasoning content when no summary is provided', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'reasoning-2',
            type: 'reasoning',
            content: ['raw reasoning content'],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([]);
  });

  it('emits streamed reasoning summary deltas when completed summary is empty', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    translateCodexAppServerNotification(
      {
        method: 'item/reasoning/summaryTextDelta',
        params: { itemId: 'reasoning-3', delta: 'checked ' },
      } as CodexAppServerNotification,
      emit,
      { state },
    );
    translateCodexAppServerNotification(
      {
        method: 'item/reasoning/summaryTextDelta',
        params: { itemId: 'reasoning-3', delta: 'the plan' },
      } as CodexAppServerNotification,
      emit,
      { state },
    );
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'reasoning-3', type: 'reasoning', summary: [] } },
      } as CodexAppServerNotification,
      emit,
      { state },
    );

    expect(events).toEqual([
      { kind: 'thinking', payload: { text: 'checked the plan' } },
    ]);
  });

  it('keeps raw reasoning text deltas hidden even when no summary is provided', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    translateCodexAppServerNotification(
      {
        method: 'item/reasoning/textDelta',
        params: { itemId: 'reasoning-4', delta: 'raw hidden thought' },
      } as CodexAppServerNotification,
      emit,
      { state },
    );
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'reasoning-4', type: 'reasoning', summary: [] } },
      } as CodexAppServerNotification,
      emit,
      { state },
    );

    expect(events).toEqual([]);
  });

  it('emits first-class compaction events and session-visible review mode messages', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/started',
        params: { item: { id: 'compact-1', type: 'contextCompaction' } },
      } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'compact-1', type: 'contextCompaction', summary: 'kept scope' } },
      } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'review-1', type: 'enteredReviewMode' } },
      } as CodexAppServerNotification,
      emit,
    );
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: { item: { id: 'review-2', type: 'exitedReviewMode' } },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'context-compaction-start',
        payload: { text: '🧭 正在压缩上下文' },
      },
      {
        kind: 'context-compaction-end',
        payload: { text: '🧭 上下文已压缩\n\nkept scope', summary: 'kept scope' },
      },
      { kind: 'message', payload: { text: '🔎 已进入 review 模式', role: 'assistant' } },
      { kind: 'message', payload: { text: '🔎 已退出 review 模式', role: 'assistant' } },
    ]);
  });

  it('maps current Codex collab tool calls to the existing Agent renderer contract', () => {
    const { emit, events } = collect();
    const item = {
      id: 'agent-1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      senderThreadId: 'lead-thread',
      receiverThreadIds: ['review-thread'],
      prompt: 'review this patch',
      model: 'gpt-5.6-codex',
      reasoningEffort: 'high',
      agentsStates: {
        'review-thread': { status: 'completed', message: null },
      },
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
          toolName: 'Agent',
          toolInput: {
            collab_tool: 'spawn_agent',
            sender_thread_id: 'lead-thread',
            receiver_thread_ids: ['review-thread'],
            prompt: 'review this patch',
            model: 'gpt-5.6-codex',
            reasoning_effort: 'high',
          },
          toolUseId: 'agent-1',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'agent-1',
          toolName: 'Agent',
          toolInput: {
            collab_tool: 'spawn_agent',
            sender_thread_id: 'lead-thread',
            receiver_thread_ids: ['review-thread'],
            prompt: 'review this patch',
            model: 'gpt-5.6-codex',
            reasoning_effort: 'high',
          },
          toolResult: {
            receiver_thread_ids: ['review-thread'],
            agents_states: {
              'review-thread': { status: 'completed', message: null },
            },
          },
          status: 'completed',
          error: undefined,
        },
      },
    ]);
  });
});
