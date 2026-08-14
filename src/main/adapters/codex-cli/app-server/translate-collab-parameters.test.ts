import { describe, expect, it } from 'vitest';
import type { CodexAppServerNotification } from './client';
import { mergeToolUsePayload } from '@shared/agent-event-merge';
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

describe('Codex app-server collaboration raw parameters', () => {
  it('keeps complete provider-native and Agent Deck collaboration parameters', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    const calls = [
      {
        name: 'spawn_agent',
        call_id: 'spawn-v1',
        arguments: JSON.stringify({
          message: 'visible spawn message',
          agent_type: 'reviewer',
          fork_context: true,
          service_tier: 'priority',
        }),
      },
      {
        name: 'send_message',
        call_id: 'send-v1',
        arguments: JSON.stringify({
          id: 'agent-7',
          message: 'visible send message',
          interrupt: true,
        }),
      },
      {
        name: 'interrupt_agent',
        call_id: 'interrupt-v1',
        arguments: JSON.stringify({ id: 'agent-7' }),
      },
      {
        name: 'wait_agent',
        call_id: 'wait-v1',
        arguments: JSON.stringify({ targets: ['agent-7', 'agent-8'], timeout_ms: 20000 }),
      },
      {
        name: 'send_input',
        call_id: 'provider-send-v1',
        arguments: JSON.stringify({ id: 'agent-7', message: 'provider input' }),
      },
      {
        name: 'resume_agent',
        call_id: 'provider-resume-v1',
        arguments: JSON.stringify({ id: 'agent-7' }),
      },
      {
        name: 'wait',
        call_id: 'provider-wait-v1',
        arguments: JSON.stringify({ ids: ['agent-7'], timeout_ms: 15000 }),
      },
      {
        name: 'close_agent',
        call_id: 'provider-close-v1',
        arguments: JSON.stringify({ id: 'agent-7' }),
      },
    ];

    for (const call of calls) {
      translateCodexAppServerNotification(
        {
          method: 'rawResponseItem/completed',
          params: { item: { type: 'function_call', namespace: 'collaboration', ...call } },
        } as CodexAppServerNotification,
        emit,
        { state },
      );
    }

    expect(events.map((event) => event.payload)).toEqual([
      {
        toolName: 'Agent',
        toolInput: {
          collab_tool: 'spawn_agent',
          message: 'visible spawn message',
          agent_type: 'reviewer',
          fork_context: true,
          service_tier: 'priority',
        },
        toolUseId: 'spawn-v1',
      },
      {
        toolName: 'Agent',
        toolInput: {
          collab_tool: 'send_message',
          id: 'agent-7',
          message: 'visible send message',
          interrupt: true,
        },
        toolUseId: 'send-v1',
      },
      {
        toolName: 'Agent',
        toolInput: { collab_tool: 'interrupt_agent', id: 'agent-7' },
        toolUseId: 'interrupt-v1',
      },
      {
        toolName: 'Agent',
        toolInput: {
          collab_tool: 'wait_agent',
          timeout_ms: 20000,
          targets: ['agent-7', 'agent-8'],
        },
        toolUseId: 'wait-v1',
      },
      {
        toolName: 'Agent',
        toolInput: {
          collab_tool: 'send_input',
          id: 'agent-7',
          message: 'provider input',
        },
        toolUseId: 'provider-send-v1',
      },
      {
        toolName: 'Agent',
        toolInput: { collab_tool: 'resume_agent', id: 'agent-7' },
        toolUseId: 'provider-resume-v1',
      },
      {
        toolName: 'Agent',
        toolInput: {
          collab_tool: 'wait_agent',
          ids: ['agent-7'],
          timeout_ms: 15000,
        },
        toolUseId: 'provider-wait-v1',
      },
      {
        toolName: 'Agent',
        toolInput: { collab_tool: 'close_agent', id: 'agent-7' },
        toolUseId: 'provider-close-v1',
      },
    ]);
    expect(JSON.stringify(events)).toContain('visible spawn message');
    expect(JSON.stringify(events)).toContain('visible send message');
  });

  it('keeps exact wait timeout when normalized collaboration events merge later', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    translateCodexAppServerNotification(
      {
        method: 'rawResponseItem/completed',
        params: {
          item: {
            type: 'function_call',
            namespace: 'collaboration',
            name: 'wait',
            call_id: 'call-wait-1',
            arguments: '{"timeout_ms":30000}',
          },
        },
      } as CodexAppServerNotification,
      emit,
      { state },
    );
    translateCodexAppServerNotification(
      {
        method: 'item/started',
        params: {
          item: {
            id: 'call-wait-1',
            type: 'collabAgentToolCall',
            tool: 'wait',
            senderThreadId: 'lead-thread',
            receiverThreadIds: [],
            prompt: null,
            model: null,
            reasoningEffort: null,
            agentsStates: {},
            status: 'inProgress',
          },
        },
      } as CodexAppServerNotification,
      emit,
      { state },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'tool-use-start',
      payload: {
        toolUseId: 'call-wait-1',
        toolInput: { collab_tool: 'wait_agent', timeout_ms: 30000 },
      },
    });
    expect(events[1]).toMatchObject({
      kind: 'tool-use-start',
      payload: {
        toolUseId: 'call-wait-1',
        toolInput: { collab_tool: 'wait_agent' },
      },
    });
    expect(mergeToolUsePayload(events[0].payload, events[1].payload)).toMatchObject({
      toolInput: {
        collab_tool: 'wait_agent',
        timeout_ms: 30000,
        sender_thread_id: 'lead-thread',
      },
    });
  });

  it('ignores non-collaboration and unknown raw function calls', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    for (const item of [
      {
        type: 'function_call',
        namespace: 'functions',
        name: 'wait_agent',
        call_id: 'wrong-namespace',
        arguments: '{"timeout_ms":30000}',
      },
      {
        type: 'function_call',
        namespace: 'collaboration',
        name: 'unknown_agent_tool',
        call_id: 'unknown-tool',
        arguments: '{}',
      },
    ]) {
      translateCodexAppServerNotification(
        { method: 'rawResponseItem/completed', params: { item } } as CodexAppServerNotification,
        emit,
        { state },
      );
    }

    expect(events).toEqual([]);
  });
});
