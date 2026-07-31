type AnyRecord = Record<string, unknown>;
type RawCollabEmit = (
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

export function collabToolInput(item: AnyRecord): Record<string, unknown> {
  const prompt = nullableString(item.prompt);
  const input: Record<string, unknown> = {
    ...(stringField(item.tool) ? { collab_tool: stringField(item.tool) } : {}),
    ...(stringField(item.senderThreadId) ? { sender_thread_id: item.senderThreadId } : {}),
    ...(stringField(item.receiverThreadId) ? { receiver_thread_id: item.receiverThreadId } : {}),
    ...(stringField(item.newThreadId) ? { new_thread_id: item.newThreadId } : {}),
    ...(prompt ? { prompt } : {}),
  };
  return input;
}

export function collabToolResult(item: AnyRecord): unknown {
  const result: Record<string, unknown> = {};
  if (stringField(item.receiverThreadId)) result.receiver_thread_id = item.receiverThreadId;
  if (stringField(item.newThreadId)) result.new_thread_id = item.newThreadId;
  if (item.agentStatus !== undefined && item.agentStatus !== null) {
    result.agent_status = item.agentStatus;
  }
  return Object.keys(result).length > 0 ? result : '';
}

/**
 * Codex v2 normalized collabToolCall items omit call arguments such as wait timeout_ms. The raw
 * response stream has
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
  const parsed = parseJsonValue(rawArguments);
  const args = asRecord(parsed);
  if (args) return { ...args, collab_tool: toolName };
  return {
    collab_tool: toolName,
    ...(rawArguments === undefined ? {} : { arguments: parsed }),
  };
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

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}
