import { describe, expect, it } from 'vitest';
import type { CodexAppServerNotification } from './client';
import { APPEND_AGGREGATED_OUTPUT } from '@shared/agent-event-merge';
import {
  TOKEN_USAGE_ALL_METRICS,
  TOKEN_USAGE_METRIC,
} from '@shared/types';
import {
  createCodexAppServerTranslateState,
  translateCodexAppServerNotification,
} from './translate';

function collect() {
  const events: { kind: string; payload: unknown }[] = [];
  return {
    emit: (kind: string, payload: unknown) => events.push({ kind, payload }),
    events,
  };
}

describe('translateCodexAppServerNotification', () => {
  it('emits token usage from app-server tokenUsage.last deltas', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: {
              totalTokens: 28,
              inputTokens: 11,
              outputTokens: 17,
              reasoningOutputTokens: 5,
              cachedInputTokens: 7,
              cacheWriteInputTokens: 3,
            },
          },
        },
      } as CodexAppServerNotification,
      emit,
      { model: 'gpt-5.5-codex' },
    );

    expect(events).toEqual([
      {
        kind: 'context-usage',
        payload: { usedTokens: 28 },
      },
      {
        kind: 'token-usage',
        payload: {
          messageId: null,
          model: 'gpt-5.5-codex',
          totalTokens: 28,
          inputTokens: 11,
          outputTokens: 17,
          reasoningTokens: 5,
          cacheReadTokens: 7,
          cacheCreationTokens: 3,
          metricScope: TOKEN_USAGE_ALL_METRICS,
        },
      },
    ]);
  });

  it('scopes partial token deltas to reported metrics and keeps provider total strict', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: {
              inputTokens: 11,
              cachedInputTokens: 7,
            },
          },
        },
      } as CodexAppServerNotification,
      emit,
      { model: 'gpt-5.6-sol' },
    );

    expect(events).toEqual([
      {
        kind: 'token-usage',
        payload: {
          messageId: null,
          model: 'gpt-5.6-sol',
          totalTokens: null,
          inputTokens: 11,
          outputTokens: null,
          reasoningTokens: null,
          cacheReadTokens: 7,
          cacheCreationTokens: null,
          metricScope:
            TOKEN_USAGE_METRIC.total |
            TOKEN_USAGE_METRIC.input |
            TOKEN_USAGE_METRIC.cacheRead,
        },
      },
    ]);
  });

  it('uses cumulative total as a watermark and suppresses repeated last snapshots', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    const first = {
      totalTokens: 28,
      inputTokens: 11,
      outputTokens: 17,
      reasoningOutputTokens: 5,
      cachedInputTokens: 7,
      cacheWriteInputTokens: 3,
    };
    const secondTotal = {
      totalTokens: 40,
      inputTokens: 16,
      outputTokens: 24,
      reasoningOutputTokens: 8,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 4,
    };
    const secondLast = {
      totalTokens: 12,
      inputTokens: 5,
      outputTokens: 7,
      reasoningOutputTokens: 3,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 1,
    };
    for (const tokenUsage of [
      { total: first, last: first },
      { total: secondTotal, last: secondLast },
      // Provider replay: positive `last`, but cumulative `total` did not advance.
      { total: secondTotal, last: secondLast },
    ]) {
      translateCodexAppServerNotification(
        { method: 'thread/tokenUsage/updated', params: { tokenUsage } } as CodexAppServerNotification,
        emit,
        { model: 'gpt-5.6-sol', state, usageMessageNamespace: 'thread-1' },
      );
    }

    const usageEvents = events.filter((event) => event.kind === 'token-usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        messageId: 'codex-usage-v2:thread-1:28-11-17-5-7-3',
        totalTokens: 28,
        inputTokens: 11,
        outputTokens: 17,
      }),
      expect.objectContaining({
        messageId: 'codex-usage-v2:thread-1:40-16-24-8-10-4',
        totalTokens: 12,
        inputTokens: 5,
        outputTokens: 7,
      }),
    ]);
  });

  it('keeps a context-only compaction snapshot out of durable token totals', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    const total = {
      totalTokens: 40,
      inputTokens: 16,
      outputTokens: 24,
      reasoningOutputTokens: 8,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 4,
    };
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { total, last: total } },
      } as CodexAppServerNotification,
      emit,
      { state },
    );
    events.length = 0;
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            total,
            last: {
              totalTokens: 250_000,
              inputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
            },
            modelContextWindow: 272_000,
          },
        },
      } as CodexAppServerNotification,
      emit,
      { state },
    );

    expect(events).toEqual([
      {
        kind: 'context-usage',
        payload: { usedTokens: 250_000, windowTokens: 272_000 },
      },
    ]);
  });

  it('uses last on the first resumed observation and gives its cumulative snapshot a stable id', () => {
    const notification = {
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: {
            totalTokens: 1_000,
            inputTokens: 900,
            outputTokens: 100,
            reasoningOutputTokens: 40,
            cachedInputTokens: 700,
            cacheWriteInputTokens: 0,
          },
          last: {
            totalTokens: 30,
            inputTokens: 20,
            outputTokens: 10,
            reasoningOutputTokens: 4,
            cachedInputTokens: 15,
            cacheWriteInputTokens: 0,
          },
        },
      },
    } as CodexAppServerNotification;
    const payloads = [createCodexAppServerTranslateState(), createCodexAppServerTranslateState()]
      .map((state) => {
        const collected = collect();
        translateCodexAppServerNotification(notification, collected.emit, {
          state,
          usageMessageNamespace: 'resumed-thread',
        });
        return collected.events.find((event) => event.kind === 'token-usage')?.payload;
      });

    expect(payloads).toEqual([
      expect.objectContaining({
        messageId: 'codex-usage-v2:resumed-thread:1000-900-100-40-700-0',
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 10,
      }),
      expect.objectContaining({
        messageId: 'codex-usage-v2:resumed-thread:1000-900-100-40-700-0',
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 10,
      }),
    ]);
  });

  it('ignores empty app-server token deltas', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { last: {} } },
      } as CodexAppServerNotification,
      emit,
      { model: 'gpt-5.6-sol' },
    );

    expect(events).toEqual([]);
  });

  it('reports the current Codex context window separately from cumulative usage', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { totalTokens: 34_567 },
            modelContextWindow: 272_000,
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events[0]).toEqual({
      kind: 'context-usage',
      payload: { usedTokens: 34_567, windowTokens: 272_000 },
    });
  });

  it('pairs native context capacity with the exact effective provider and model', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { totalTokens: 34_567 },
            modelContextWindow: 272_000,
          },
        },
      } as CodexAppServerNotification,
      emit,
      {
        runtimeIdentity: {
          runtimeProvider: 'openrouter',
          model: 'gpt-5.6-sol',
        },
      },
    );

    expect(events[0]).toEqual({
      kind: 'context-usage',
      payload: {
        usedTokens: 34_567,
        windowTokens: 272_000,
        runtimeIdentity: {
          runtimeProvider: 'openrouter',
          model: 'gpt-5.6-sol',
        },
        capacitySource: 'runtime-usage',
      },
    });
  });

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

  it('renders image display items without persisting inline image bytes', () => {
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
          status: 'completed',
          error: undefined,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('large-base64-payload');
  });

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


  it('marks command output deltas so downstream event stores append output and preserve command input', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/commandExecution/outputDelta',
        params: { itemId: 'cmd-1', delta: 'src/main/foo.ts\n' },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'Bash',
          toolUseId: 'cmd-1',
          aggregatedOutput: 'src/main/foo.ts\n',
          [APPEND_AGGREGATED_OUTPUT]: true,
          status: 'inProgress',
        },
      },
    ]);
  });

  it('keeps Bash command input on command completion as a detail fallback', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'cmd-2',
            type: 'commandExecution',
            command: 'rg foo src',
            aggregatedOutput: 'src/a.ts\n',
            exitCode: 0,
            status: 'completed',
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'cmd-2',
          toolName: 'Bash',
          toolInput: { command: 'rg foo src' },
          toolResult: 'src/a.ts\n',
          exitCode: 0,
          durationMs: null,
          status: 'completed',
        },
      },
    ]);
  });

  it('normalizes app-server file change kind objects before persisting metadata', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-1',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: '/tmp/a.ts',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'file-changed',
        payload: {
          filePath: '/tmp/a.ts',
          kind: 'text',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind: 'update',
            patchStatus: 'completed',
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
          toolCallId: 'patch-1',
        },
      },
    ]);
  });

  it('skips Codex file changes that did not produce an effective content change', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-noop',
            type: 'fileChange',
            status: 'completed',
            changes: [
              { path: '/tmp/empty.ts', kind: { type: 'update' }, diff: '' },
              {
                path: '/tmp/header-only.ts',
                kind: { type: 'update' },
                diff: [
                  'diff --git a/header-only.ts b/header-only.ts',
                  'index 1111111..1111111 100644',
                  '--- a/header-only.ts',
                  '+++ b/header-only.ts',
                ].join('\n'),
              },
              {
                path: '/tmp/same.ts',
                kind: { type: 'update' },
                diff: [
                  'diff --git a/same.ts b/same.ts',
                  '--- a/same.ts',
                  '+++ b/same.ts',
                  '@@ -1 +1 @@',
                  '-same',
                  '+same',
                ].join('\n'),
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([]);
  });

  it('skips incomplete Codex file change items', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-failed',
            type: 'fileChange',
            status: 'failed',
            changes: [
              {
                path: '/tmp/a.ts',
                kind: { type: 'update' },
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([]);
  });

  it('keeps non-text Codex diff signals that do not have parseable hunks', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-binary',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: '/tmp/image.png',
                kind: { type: 'update' },
                diff: [
                  'diff --git a/image.png b/image.png',
                  'Binary files a/image.png and b/image.png differ',
                ].join('\n'),
              },
              {
                path: '/tmp/renamed.ts',
                kind: { type: 'move' },
                diff: [
                  'diff --git a/old.ts b/renamed.ts',
                  'similarity index 100%',
                  'rename from old.ts',
                  'rename to renamed.ts',
                ].join('\n'),
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({
      filePath: '/tmp/image.png',
      metadata: { changeKind: 'update' },
    });
    expect(events[1].payload).toMatchObject({
      filePath: '/tmp/renamed.ts',
      metadata: { changeKind: 'move' },
    });
  });
});
