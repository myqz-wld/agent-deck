type AnyRecord = Record<string, unknown>;
type CollabEmit = (
  kind: 'tool-use-start' | 'tool-use-end',
  payload: Record<string, unknown>,
) => void;

const RAW_COLLAB_TOOL_NAMES = new Set([
  'spawn_agent',
  'send_input',
  'resume_agent',
  'wait',
  'close_agent',
  'list_agents',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'wait_agent',
]);

export function translateNormalizedCollabItemStarted(
  item: AnyRecord,
  emit: CollabEmit,
): boolean {
  if (item.type === 'collabAgentToolCall') {
    emit('tool-use-start', {
      toolName: 'Agent',
      toolInput: collabAgentToolInput(item),
      toolUseId: item.id,
    });
    return true;
  }
  if (item.type !== 'subAgentActivity') return false;
  emit('tool-use-start', {
    toolName: 'Agent',
    toolInput: subAgentActivityInput(item),
    toolUseId: item.id,
  });
  return true;
}

export function translateNormalizedCollabItemCompleted(
  item: AnyRecord,
  emit: CollabEmit,
): boolean {
  if (item.type === 'collabAgentToolCall') {
    emit('tool-use-end', {
      toolUseId: item.id,
      toolName: 'Agent',
      toolInput: collabAgentToolInput(item),
      toolResult: collabAgentToolResult(item),
      status: item.status,
      error: item.status === 'failed' ? collabAgentFailure(item) : undefined,
    });
    return true;
  }
  if (item.type !== 'subAgentActivity') return false;
  const toolInput = subAgentActivityInput(item);
  emit('tool-use-end', {
    toolUseId: item.id,
    toolName: 'Agent',
    toolInput,
    toolResult: {
      activity_kind: item.kind,
      agent_thread_id: item.agentThreadId,
      agent_path: item.agentPath,
    },
    status: 'completed',
  });
  return true;
}

export function collabAgentToolInput(item: AnyRecord): Record<string, unknown> {
  const prompt = nullableString(item.prompt);
  const input: Record<string, unknown> = {
    ...(stringField(item.tool) ? { collab_tool: normalizeCollabToolName(item.tool) } : {}),
    ...(stringField(item.senderThreadId) ? { sender_thread_id: item.senderThreadId } : {}),
    ...(Array.isArray(item.receiverThreadIds)
      ? { receiver_thread_ids: stringArray(item.receiverThreadIds) }
      : {}),
    ...(prompt ? { prompt } : {}),
    ...(stringField(item.model) ? { model: item.model } : {}),
    ...(stringField(item.reasoningEffort)
      ? { reasoning_effort: item.reasoningEffort }
      : {}),
  };
  return input;
}

export function collabAgentToolResult(item: AnyRecord): unknown {
  const result: Record<string, unknown> = {};
  if (Array.isArray(item.receiverThreadIds)) {
    result.receiver_thread_ids = stringArray(item.receiverThreadIds);
  }
  const states = asRecord(item.agentsStates);
  if (states) result.agents_states = states;
  return Object.keys(result).length > 0 ? result : '';
}

/**
 * Codex v2 normalized collaboration items omit call arguments such as wait_agent.timeout_ms. The
 * raw response stream has every function call. Keep the complete local tool input and output,
 * matching Claude tool-event visibility. This intentionally includes encrypted-looking message
 * strings: they are still the only representation Codex exposed to the local client and remain
 * useful for transcript parity.
 */
export function translateRawCollabResponseItem(
  params: unknown,
  emit: CollabEmit,
  pendingCalls?: Map<string, Record<string, unknown>>,
): void {
  const item = asRecord(asRecord(params)?.item);
  if (!item) return;

  if (item.type === 'function_call') {
    const namespace = stringField(item.namespace);
    const toolName = stringField(item.name);
    const callId = stringField(item.call_id);
    if (
      namespace !== 'collaboration' ||
      !callId ||
      !RAW_COLLAB_TOOL_NAMES.has(toolName)
    ) {
      return;
    }

    const toolInput = rawCollabToolInput(toolName, item.arguments);
    pendingCalls?.set(callId, toolInput);
    emit('tool-use-start', {
      toolName: 'Agent',
      toolInput,
      toolUseId: callId,
    });
    return;
  }

  if (item.type !== 'function_call_output') return;
  const callId = stringField(item.call_id);
  const toolInput = callId ? pendingCalls?.get(callId) : undefined;
  if (!callId || !toolInput) return;
  pendingCalls?.delete(callId);
  const failed = rawCollabOutputFailed(item.output);
  emit('tool-use-end', {
    toolUseId: callId,
    toolName: 'Agent',
    toolInput,
    toolResult: item.output,
    ...(failed
      ? { status: 'failed', error: 'Codex collaboration call failed' }
      : {}),
  });
}

function rawCollabToolInput(toolName: string, rawArguments: unknown): Record<string, unknown> {
  const collabTool = normalizeCollabToolName(toolName);
  const parsed = parseJsonValue(rawArguments);
  const args = asRecord(parsed);
  if (args) return { ...args, collab_tool: collabTool };
  return {
    collab_tool: collabTool,
    ...(rawArguments === undefined ? {} : { arguments: parsed }),
  };
}

function subAgentActivityInput(item: AnyRecord): Record<string, unknown> {
  const kind = stringField(item.kind);
  const threadId = stringField(item.agentThreadId);
  const agentPath = stringField(item.agentPath);
  return {
    ...(agentPath ? { target: agentPath } : {}),
    ...(threadId ? { receiver_thread_ids: [threadId], agent_thread_id: threadId } : {}),
    ...(agentPath ? { agent_path: agentPath } : {}),
    ...(kind ? { activity_kind: kind, description: subAgentActivityDescription(kind) } : {}),
  };
}

function subAgentActivityDescription(kind: string): string {
  if (kind === 'started') return '子代理已启动';
  if (kind === 'interacted') return '已向子代理发送消息';
  if (kind === 'interrupted') return '子代理已中断';
  return `子代理活动：${kind}`;
}

function collabAgentFailure(item: AnyRecord): string {
  const states = asRecord(item.agentsStates);
  if (states) {
    for (const value of Object.values(states)) {
      const message = stringField(asRecord(value)?.message);
      if (message) return message;
    }
  }
  return 'Collab agent tool call failed';
}

function normalizeCollabToolName(value: unknown): string {
  const name = stringField(value);
  switch (name) {
    case 'spawnAgent':
      return 'spawn_agent';
    case 'sendInput':
      return 'send_input';
    case 'resumeAgent':
      return 'resume_agent';
    case 'closeAgent':
      return 'close_agent';
    case 'wait':
      return 'wait_agent';
    default:
      return name;
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function rawCollabOutputFailed(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => {
      const content = asRecord(entry);
      return content?.type === 'input_text' && rawCollabOutputFailed(content.text);
    });
  }
  const record = asRecord(value);
  if (record) {
    const status = stringField(record.status).toLowerCase();
    return (
      record.success === false ||
      record.is_error === true ||
      status === 'failed' ||
      status === 'error' ||
      (record.error !== null && record.error !== undefined)
    );
  }
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'string') return rawCollabOutputFailed(parsed);
  } catch {
    // Plain-text collaboration output is expected for some tools.
  }
  const leadingFailure =
    /^(?:collab(?:oration)?(?:\s+[\w-]+)?\s+)?(?:error|failed|failure|unable|cannot|can't|invalid|not found)\b/i;
  const providerFailurePhrase =
    /\b(?:can't|cannot|could not|not found|does not exist|is closed|is missing|is not (?:a spawned agent|active|running)|must be|not allowed|timed out)\b/i;
  return leadingFailure.test(text) || providerFailurePhrase.test(text);
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringField(value) || null;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}
