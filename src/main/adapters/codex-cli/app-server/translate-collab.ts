type AnyRecord = Record<string, unknown>;
type RawCollabEmit = (
  kind: 'tool-use-start' | 'tool-use-end',
  payload: Record<string, unknown>,
) => void;

const RAW_COLLAB_TOOL_NAMES = new Set([
  'spawn_agent',
  'list_agents',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'resume_agent',
  'close_agent',
  'send_input',
  'wait_agent',
  'wait',
]);

export function collabAgentToolInput(item: AnyRecord): Record<string, unknown> {
  const prompt = firstString(item.prompt, item.instructions, item.input, item.task);
  const description = firstString(item.description, item.title, item.summary);
  const subagentType = firstString(
    item.subagent_type,
    item.subagentType,
    item.agentName,
    item.agent,
    item.name,
  );
  const input: Record<string, unknown> = {
    ...(subagentType ? { subagent_type: subagentType } : {}),
    ...(stringField(item.tool) ? { collab_tool: normalizeCollabToolName(item.tool) } : {}),
    ...(stringField(item.senderThreadId) ? { sender_thread_id: item.senderThreadId } : {}),
    ...(Array.isArray(item.receiverThreadIds)
      ? { receiver_thread_ids: stringArray(item.receiverThreadIds) }
      : {}),
    ...(prompt ? { prompt } : {}),
    ...(description ? { description } : {}),
  };
  if ('model' in item) input.model = nullableString(item.model);
  if ('reasoningEffort' in item) input.reasoning_effort = nullableString(item.reasoningEffort);
  return input;
}

export function collabAgentToolResult(item: AnyRecord): unknown {
  for (const legacyResult of [item.result, item.output, item.content, item.contentItems]) {
    if (legacyResult !== undefined && legacyResult !== null) return legacyResult;
  }
  const result: Record<string, unknown> = {};
  if (Array.isArray(item.receiverThreadIds)) {
    result.receiver_thread_ids = stringArray(item.receiverThreadIds);
  }
  const states = asRecord(item.agentsStates);
  if (states) result.agents_states = states;
  return Object.keys(result).length > 0 ? result : '';
}

export function collabAgentErrorMessage(item: AnyRecord): string | undefined {
  const err = asRecord(item.error);
  return stringField(err?.message) || stringField(item.errorMessage) || undefined;
}

/**
 * Codex v2 only emits normalized collabAgentToolCall items for a subset of collaboration calls,
 * and those items omit call arguments such as wait_agent.timeout_ms. The raw response stream has
 * every function call. Keep the complete local tool input and output, matching Claude tool-event
 * visibility. This intentionally includes encrypted-looking message strings: they are still the
 * only representation Codex exposed to the local client and remain useful for transcript parity.
 */
export function translateRawCollabResponseItem(
  params: unknown,
  emit: RawCollabEmit,
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

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringField(value);
    if (text) return text;
  }
  return '';
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
