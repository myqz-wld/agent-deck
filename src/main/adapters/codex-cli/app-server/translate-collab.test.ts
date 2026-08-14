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

describe('Codex app-server collaboration translation', () => {
  it('preserves the current app-server collab-agent item shape', () => {
    const { emit, events } = collect();
    const item = {
      id: 'agent-2',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      senderThreadId: 'lead-thread',
      receiverThreadIds: ['child-thread'],
      prompt: 'inspect the adapter',
      model: 'gpt-5.6-codex',
      reasoningEffort: 'xhigh',
      agentsStates: {
        'child-thread': { status: 'running', message: null },
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

    const toolInput = {
      collab_tool: 'spawn_agent',
      sender_thread_id: 'lead-thread',
      receiver_thread_ids: ['child-thread'],
      prompt: 'inspect the adapter',
      model: 'gpt-5.6-codex',
      reasoning_effort: 'xhigh',
    };
    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'Agent',
          toolInput,
          toolUseId: 'agent-2',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'agent-2',
          toolName: 'Agent',
          toolInput,
          toolResult: {
            receiver_thread_ids: ['child-thread'],
            agents_states: {
              'child-thread': { status: 'running', message: null },
            },
          },
          status: 'completed',
          error: undefined,
        },
      },
    ]);
  });

  it('renders current MultiAgentV2 sub-agent activity without raw events', () => {
    const { emit, events } = collect();
    const item = {
      id: 'call-followup-1',
      type: 'subAgentActivity',
      kind: 'interacted',
      agentThreadId: 'child-thread',
      agentPath: '/root/audit_adapter',
    };

    translateCodexAppServerNotification(
      { method: 'item/completed', params: { item } } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'call-followup-1',
          toolName: 'Agent',
          toolInput: {
            target: '/root/audit_adapter',
            receiver_thread_ids: ['child-thread'],
            agent_thread_id: 'child-thread',
            agent_path: '/root/audit_adapter',
            activity_kind: 'interacted',
            description: '已向子代理发送消息',
          },
          toolResult: {
            activity_kind: 'interacted',
            agent_thread_id: 'child-thread',
            agent_path: '/root/audit_adapter',
          },
          status: 'completed',
        },
      },
    ]);
  });

  it('ignores the retired normalized collaboration item shape', () => {
    const { emit, events } = collect();
    const item = {
      id: 'retired-agent-1',
      type: 'collabToolCall',
      tool: 'spawn_agent',
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

    expect(events).toEqual([]);
  });

  it('preserves complete raw collaboration inputs and outputs for local display', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    translateCodexAppServerNotification(
      {
        method: 'rawResponseItem/completed',
        params: {
          item: {
            type: 'function_call',
            namespace: 'collaboration',
            name: 'spawn_agent',
            call_id: 'call-spawn-1',
            arguments: JSON.stringify({
              task_name: 'audit_adapter',
              fork_turns: 'all',
              message: 'gAAAA-sensitive-encrypted-prompt',
            }),
          },
        },
      } as CodexAppServerNotification,
      emit,
      { state },
    );
    translateCodexAppServerNotification(
      {
        method: 'rawResponseItem/completed',
        params: {
          item: {
            type: 'function_call_output',
            call_id: 'call-spawn-1',
            output: 'gAAAA-encrypted-child-output',
          },
        },
      } as CodexAppServerNotification,
      emit,
      { state },
    );

    const toolInput = {
      collab_tool: 'spawn_agent',
      task_name: 'audit_adapter',
      fork_turns: 'all',
      message: 'gAAAA-sensitive-encrypted-prompt',
    };
    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'Agent',
          toolInput,
          toolUseId: 'call-spawn-1',
        },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'call-spawn-1',
          toolName: 'Agent',
          toolInput,
          toolResult: 'gAAAA-encrypted-child-output',
        },
      },
    ]);
    expect(JSON.stringify(events)).toContain('gAAAA-sensitive-encrypted-prompt');
    expect(JSON.stringify(events)).toContain('gAAAA-encrypted-child-output');
    expect(
      mergeToolUsePayload(
        {
          ...(events[1].payload as Record<string, unknown>),
          status: 'failed',
          error: 'normalized failure',
        },
        events[1].payload,
      ),
    ).toMatchObject({
      status: 'failed',
      error: 'normalized failure',
      toolResult: 'gAAAA-encrypted-child-output',
    });
  });

  it('keeps prompt, structured items, extension fields, and malformed raw arguments intact', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    const completeInput = {
      target: 'agent-7',
      message: 'gAAAA-encrypted-message',
      prompt: 'explicit prompt',
      items: [{ type: 'text', text: 'structured message' }],
      extension: { source: 'local-client' },
    };

    for (const item of [
      {
        type: 'function_call',
        namespace: 'collaboration',
        name: 'send_message',
        call_id: 'call-complete-input',
        arguments: JSON.stringify(completeInput),
      },
      {
        type: 'function_call',
        namespace: 'collaboration',
        name: 'send_message',
        call_id: 'call-malformed-input',
        arguments: 'gAAAA-not-json-but-still-visible',
      },
    ]) {
      translateCodexAppServerNotification(
        { method: 'rawResponseItem/completed', params: { item } } as CodexAppServerNotification,
        emit,
        { state },
      );
    }

    expect(events.map((event) => event.payload)).toEqual([
      {
        toolName: 'Agent',
        toolInput: { ...completeInput, collab_tool: 'send_message' },
        toolUseId: 'call-complete-input',
      },
      {
        toolName: 'Agent',
        toolInput: {
          collab_tool: 'send_message',
          arguments: 'gAAAA-not-json-but-still-visible',
        },
        toolUseId: 'call-malformed-input',
      },
    ]);
  });

  it('marks raw collaboration failures while retaining the provider output', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    const opts = { state };
    const failures: { name: string; output: unknown; visibleText: string }[] = [
      {
        name: 'spawn_agent',
        output: 'Collab spawn failed: agent thread limit reached',
        visibleText: 'agent thread limit reached',
      },
      {
        name: 'send_message',
        output: "Empty message can't be sent to an agent",
        visibleText: "Empty message can't be sent to an agent",
      },
      {
        name: 'followup_task',
        output: "Follow-up tasks can't target the root agent",
        visibleText: "Follow-up tasks can't target the root agent",
      },
      {
        name: 'interrupt_agent',
        output: 'target agent is missing an agent_path',
        visibleText: 'target agent is missing an agent_path',
      },
      {
        name: 'interrupt_agent',
        output: 'agent with id agent-7 not found',
        visibleText: 'agent with id agent-7 not found',
      },
      {
        name: 'interrupt_agent',
        output: 'root is not a spawned agent',
        visibleText: 'root is not a spawned agent',
      },
      {
        name: 'wait_agent',
        output: 'timeout_ms must be greater than zero',
        visibleText: 'timeout_ms must be greater than zero',
      },
      {
        name: 'followup_task',
        output: [{ type: 'input_text', text: 'agent with id agent-8 is closed' }],
        visibleText: 'agent with id agent-8 is closed',
      },
    ];

    for (const [index, { name, output }] of failures.entries()) {
      const callId = `call-failed-${index}`;
      translateCodexAppServerNotification(
        {
          method: 'rawResponseItem/completed',
          params: {
            item: {
              type: 'function_call',
              namespace: 'collaboration',
              name,
              call_id: callId,
              arguments: '{"task_name":"review","id":"agent-7","target":"agent-7"}',
            },
          },
        } as CodexAppServerNotification,
        emit,
        opts,
      );
      translateCodexAppServerNotification(
        {
          method: 'rawResponseItem/completed',
          params: { item: { type: 'function_call_output', call_id: callId, output } },
        } as CodexAppServerNotification,
        emit,
        opts,
      );
    }

    const endEvents = events.filter((event) => event.kind === 'tool-use-end');
    expect(endEvents).toHaveLength(failures.length);
    for (const [index, event] of endEvents.entries()) {
      expect(event.payload).toMatchObject({
        toolName: 'Agent',
        toolResult: failures[index].output,
        status: 'failed',
        error: 'Codex collaboration call failed',
      });
    }
    for (const { visibleText } of failures) {
      expect(JSON.stringify(events)).toContain(visibleText);
    }
    expect(
      mergeToolUsePayload(
        {
          ...(endEvents[0].payload as Record<string, unknown>),
          status: 'completed',
          error: undefined,
        },
        endEvents[0].payload,
      ),
    ).toMatchObject({ status: 'failed', error: 'Codex collaboration call failed' });
  });

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
