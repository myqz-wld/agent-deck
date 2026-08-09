export interface LiveScenario {
  readonly content: string | null;
  readonly kind: 'read' | 'write';
  readonly target: string;
  issued: boolean;
  resultBody: string | null;
}

export interface LiveUpstreamTool {
  readonly function?: {
    readonly name?: unknown;
    readonly parameters?: {
      readonly properties?: Record<string, unknown>;
    };
  };
  readonly name?: unknown;
  readonly parameters?: {
    readonly properties?: Record<string, unknown>;
  };
}

export function liveToolName(tool: LiveUpstreamTool): string {
  return String(tool.function?.name ?? tool.name ?? '');
}

export function liveToolProperties(tool: LiveUpstreamTool): Record<string, unknown> {
  return tool.function?.parameters?.properties ?? tool.parameters?.properties ?? {};
}

export function fakeCompletion(
  text = 'LIVE_OK',
  id = 'chatcmpl-agent-deck-live',
): Response {
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      created: 1_786_177_000,
      model: 'grok-code-fast-1',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: 1_786_177_000,
      model: 'grok-code-fast-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  const body = `${chunks.map((chunk) =>
    `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolArguments(
  tool: LiveUpstreamTool,
  scenario: LiveScenario,
): Record<string, unknown> {
  const properties = liveToolProperties(tool);
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    if (['file_path', 'filename', 'path', 'target_file'].includes(key)) {
      args[key] = scenario.target;
    } else if (['content', 'data', 'text', 'new_string'].includes(key)) {
      args[key] = scenario.content ?? '';
    } else if (key === 'old_string') {
      args[key] = '';
    } else if (key === 'offset') {
      args[key] = 0;
    } else if (key === 'limit' || key === 'line_end') {
      args[key] = 20;
    } else if (key === 'line_start') {
      args[key] = 1;
    }
  }
  return args;
}

export function fakeToolCall(tool: LiveUpstreamTool, scenario: LiveScenario): Response {
  const chunks = [
    {
      id: 'tool-call-agent-deck-live',
      object: 'chat.completion.chunk',
      created: 1_786_177_000,
      model: 'grok-code-fast-1',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: `live-${scenario.kind}-tool`,
            type: 'function',
            function: {
              name: liveToolName(tool),
              arguments: JSON.stringify(toolArguments(tool, scenario)),
            },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'tool-call-agent-deck-live',
      object: 'chat.completion.chunk',
      created: 1_786_177_000,
      model: 'grok-code-fast-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function responsesEvent(type: string, sequenceNumber: number, value: Record<string, unknown>): string {
  const event = { ...value, sequence_number: sequenceNumber, type };
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function responseRecord(output: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    completed_at: 1_786_177_001,
    created_at: 1_786_177_000,
    error: null,
    id: 'resp-agent-deck-live',
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    model: 'grok-4.5',
    object: 'response',
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    status: 'completed',
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  };
}

export function fakeResponsesCompletion(text = 'AUXILIARY_OK'): Response {
  const item = {
    content: [{ annotations: [], text, type: 'output_text' }],
    id: 'msg-agent-deck-live',
    role: 'assistant',
    status: 'completed',
    type: 'message',
  };
  const response = responseRecord([item]);
  const events = [
    responsesEvent('response.created', 0, { response: { ...response, output: [], status: 'in_progress' } }),
    responsesEvent('response.output_item.added', 1, {
      item: { ...item, content: [], status: 'in_progress' }, output_index: 0,
    }),
    responsesEvent('response.content_part.added', 2, {
      content_index: 0, item_id: item.id, output_index: 0,
      part: { annotations: [], text: '', type: 'output_text' },
    }),
    responsesEvent('response.output_text.delta', 3, {
      content_index: 0, delta: text, item_id: item.id, output_index: 0,
    }),
    responsesEvent('response.output_text.done', 4, {
      content_index: 0, item_id: item.id, output_index: 0, text,
    }),
    responsesEvent('response.content_part.done', 5, {
      content_index: 0, item_id: item.id, output_index: 0, part: item.content[0],
    }),
    responsesEvent('response.output_item.done', 6, { item, output_index: 0 }),
    responsesEvent('response.completed', 7, { response }),
  ];
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function fakeResponsesToolCall(
  tool: LiveUpstreamTool,
  scenario: LiveScenario,
): Response {
  const argumentsValue = JSON.stringify(toolArguments(tool, scenario));
  const item = {
    arguments: argumentsValue,
    call_id: `live-${scenario.kind}-tool`,
    id: `fc-live-${scenario.kind}`,
    name: liveToolName(tool),
    status: 'completed',
    type: 'function_call',
  };
  const response = responseRecord([item]);
  const events = [
    responsesEvent('response.created', 0, { response: { ...response, output: [], status: 'in_progress' } }),
    responsesEvent('response.output_item.added', 1, {
      item: { ...item, arguments: '', status: 'in_progress' }, output_index: 0,
    }),
    responsesEvent('response.function_call_arguments.delta', 2, {
      delta: argumentsValue, item_id: item.id, output_index: 0,
    }),
    responsesEvent('response.function_call_arguments.done', 3, {
      arguments: argumentsValue, item_id: item.id, name: item.name, output_index: 0,
    }),
    responsesEvent('response.output_item.done', 4, { item, output_index: 0 }),
    responsesEvent('response.completed', 5, { response }),
  ];
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
