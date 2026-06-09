import { describe, expect, it } from 'vitest';
import type { CodexAppServerNotification } from './client';
import { APPEND_AGGREGATED_OUTPUT } from '@shared/agent-event-merge';
import { translateCodexAppServerNotification } from './translate';

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
              inputTokens: 11,
              outputTokens: 17,
              reasoningOutputTokens: 5,
              cachedInputTokens: 7,
            },
          },
        },
      } as CodexAppServerNotification,
      emit,
      { model: 'gpt-5.5-codex' },
    );

    expect(events).toEqual([
      {
        kind: 'token-usage',
        payload: {
          messageId: null,
          model: 'gpt-5.5-codex',
          inputTokens: 11,
          outputTokens: 22,
          cacheReadTokens: 7,
          cacheCreationTokens: 0,
        },
      },
    ]);
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

  it('normalizes skill dynamic tool calls to the existing Skill renderer contract', () => {
    const { emit, events } = collect();
    const item = {
      id: 'dyn-1',
      type: 'dynamicToolCall',
      namespace: 'skills',
      tool: 'invoke',
      arguments: { skill: 'prompt-asset-improver', args: 'audit durable prompts' },
      contentItems: [{ type: 'text', text: 'done' }],
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

  it('emits session-visible messages for app-server compaction and review mode items', () => {
    const { emit, events } = collect();
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
        kind: 'message',
        payload: { text: '🧭 上下文已压缩\n\nkept scope', role: 'assistant' },
      },
      { kind: 'message', payload: { text: '🔎 已进入 review 模式', role: 'assistant' } },
      { kind: 'message', payload: { text: '🔎 已退出 review 模式', role: 'assistant' } },
    ]);
  });

  it('maps Codex collab agent tool calls to the existing Agent renderer contract', () => {
    const { emit, events } = collect();
    const item = {
      id: 'agent-1',
      type: 'collabAgentToolCall',
      agentName: 'reviewer-codex',
      prompt: 'review this patch',
      result: 'no blockers',
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
          toolName: 'Agent',
          toolInput: { subagent_type: 'reviewer-codex', prompt: 'review this patch' },
          toolUseId: 'agent-1',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'agent-1',
          toolName: 'Agent',
          toolResult: 'no blockers',
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
                diff: '@@ -1 +1 @@',
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
            diff: '@@ -1 +1 @@',
          },
          toolCallId: 'patch-1',
        },
      },
    ]);
  });
});
