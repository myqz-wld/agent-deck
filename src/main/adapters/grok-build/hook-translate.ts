import type { AgentEvent } from '@shared/types';

const AGENT_ID = 'grok-build';

export interface BaseGrokHookPayload {
  sessionId: string;
  cwd?: string;
  workspaceRoot?: string;
  hookEventName?: string;
  model?: string;
  modelId?: string;
  timestamp?: string | number;
  transcriptPath?: string;
  permissionMode?: string;
  promptId?: string;
  agentId?: string;
  agentType?: string;
}

type AnyRecord = Record<string, unknown>;

function event<P>(
  payload: BaseGrokHookPayload & AnyRecord,
  kind: AgentEvent<P>['kind'],
  value: P,
): AgentEvent<P> {
  return {
    sessionId: payload.sessionId,
    agentId: AGENT_ID,
    kind,
    payload: value,
    ts: hookTimestamp(payload.timestamp),
  };
}

function firstString(payload: AnyRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

function firstRawString(payload: AnyRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return fallback;
}

function firstValue(payload: AnyRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key];
  }
  return undefined;
}

function firstNumber(payload: AnyRecord, keys: string[]): number | undefined {
  const value = firstValue(payload, keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstBoolean(payload: AnyRecord, keys: string[]): boolean | undefined {
  const value = firstValue(payload, keys);
  return typeof value === 'boolean' ? value : undefined;
}

function hookTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function commonPayload(
  payload: BaseGrokHookPayload & AnyRecord,
): Record<string, unknown> {
  return {
    cwd: payload.cwd,
    workspaceRoot: payload.workspaceRoot,
    hookEventName: payload.hookEventName,
    model: firstString(payload, ['modelId', 'model']) || undefined,
    timestamp: payload.timestamp,
    transcriptPath:
      firstString(payload, ['transcriptPath', 'transcript_path']) || undefined,
    permissionMode:
      firstString(payload, ['permissionMode', 'permission_mode']) || undefined,
    promptId: firstString(payload, ['promptId', 'prompt_id']) || undefined,
    agentId: firstString(payload, ['agentId', 'agent_id']) || undefined,
    agentType: firstString(payload, ['agentType', 'agent_type']) || undefined,
  };
}

function toolFields(payload: BaseGrokHookPayload & AnyRecord): Record<string, unknown> {
  return {
    toolName: firstString(payload, ['toolName', 'tool_name']) || undefined,
    toolInput: firstValue(payload, ['toolInput', 'tool_input']),
    toolUseId:
      firstString(payload, ['toolUseId', 'toolCallId', 'tool_use_id']) || undefined,
    toolInputTruncated: firstBoolean(payload, [
      'toolInputTruncated',
      'tool_input_truncated',
    ]),
    toolResultTruncated: firstBoolean(payload, [
      'toolResultTruncated',
      'tool_result_truncated',
    ]),
    durationMs: firstNumber(payload, ['durationMs', 'duration_ms']),
    isBackgrounded: firstBoolean(payload, ['isBackgrounded', 'is_backgrounded']),
    isInterrupt: firstBoolean(payload, ['isInterrupt', 'is_interrupt']),
    subagentType:
      firstString(payload, ['subagentType', 'subagent_type']) || undefined,
  };
}

export interface GrokPromptNormalization {
  text: string;
  rawText: string;
  normalizedBy?: 'grok-user-query-envelope-v1';
}

/**
 * Grok's normal interactive path wraps the submitted text in one canonical outer envelope:
 * `<user_query>\n...\n</user_query>`. Strip exactly that single provider-owned layer for display.
 *
 * The transform is deliberately anchored, non-recursive, and newline-sensitive:
 * - nested tags typed by the user remain intact after the outer layer is removed;
 * - malformed/sibling/prefixed content is preserved verbatim;
 * - rawText is always retained because Grok's `--verbatim` path exposes no provenance bit, so a
 *   user-authored canonical envelope is inherently indistinguishable from the harness wrapper.
 */
export function normalizeGrokHookPrompt(rawText: string): GrokPromptNormalization {
  const envelopes = [
    { open: '<user_query>\n', close: '\n</user_query>' },
    { open: '<user_query>\r\n', close: '\r\n</user_query>' },
  ] as const;
  for (const { open, close } of envelopes) {
    if (rawText.startsWith(open) && rawText.endsWith(close)) {
      return {
        text: rawText.slice(open.length, rawText.length - close.length),
        rawText,
        normalizedBy: 'grok-user-query-envelope-v1',
      };
    }
  }
  return { text: rawText, rawText };
}

export function translateGrokSessionStart(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'session-start', {
    ...commonPayload(payload),
    source: firstString(payload, ['source']) || undefined,
  });
}

export function translateGrokUserPrompt(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  const rawText = firstRawString(
    payload,
    ['prompt', 'userPrompt', 'message'],
    'Grok prompt submitted',
  );
  const normalized = normalizeGrokHookPrompt(rawText);
  return event(payload, 'message', {
    role: 'user',
    text: normalized.text,
    rawText: normalized.rawText,
    metadata: {
      ...commonPayload(payload),
      normalization: normalized.normalizedBy,
    },
  });
}

export function translateGrokPreToolUse(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'tool-use-start', {
    ...commonPayload(payload),
    ...toolFields(payload),
  });
}

export function translateGrokPostToolUse(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'tool-use-end', {
    ...commonPayload(payload),
    ...toolFields(payload),
    toolResult: firstValue(payload, [
      'toolResult',
      'toolOutput',
      'toolResponse',
      'tool_result',
      'tool_output',
    ]),
    status: 'completed',
  });
}

export function translateGrokPostToolUseFailure(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'tool-use-end', {
    ...commonPayload(payload),
    ...toolFields(payload),
    status: 'failed',
    error:
      firstString(payload, ['error', 'errorMessage', 'message'], 'Grok tool failed'),
    errorDetails:
      firstString(payload, ['errorDetails', 'error_details']) || undefined,
  });
}

export function translateGrokPermissionDenied(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'tool-use-end', {
    ...commonPayload(payload),
    ...toolFields(payload),
    status: 'denied',
    error:
      firstString(payload, ['reason', 'error', 'message'], 'Grok tool permission denied'),
  });
}

export function translateGrokPostCompact(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  const trigger = firstString(payload, ['trigger']);
  return event(payload, 'message', {
    role: 'assistant',
    text: `Grok context compacted${trigger ? ` (${trigger})` : ''}`,
    metadata: commonPayload(payload),
  });
}

export function translateGrokNotification(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  const notificationType =
    firstString(payload, ['notificationType', 'notification_type', 'type']) || undefined;
  const title = firstString(payload, ['title']) || undefined;
  const message = firstString(payload, ['message', 'title'], 'Grok notification');
  const actionRequiredTypes = new Set([
    'permission_prompt',
    'permission_request',
    'idle_prompt',
    'elicitation_dialog',
    'input_required',
  ]);
  if (notificationType && !actionRequiredTypes.has(notificationType)) {
    return event(payload, 'message', {
      role: 'assistant',
      text: message,
      metadata: {
        ...commonPayload(payload),
        notification: true,
        notificationType,
        title,
        level: firstString(payload, ['level']) || undefined,
      },
    });
  }
  return event(payload, 'waiting-for-user', {
    type: notificationType ?? 'grok-terminal-notification',
    title,
    message,
    ...commonPayload(payload),
  });
}

export function translateGrokStop(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent[] {
  const lastAssistantMessage =
    firstString(payload, ['lastAssistantMessage', 'lastMessage']) || undefined;
  const events: AgentEvent[] = [];
  if (lastAssistantMessage) {
    events.push(
      event(payload, 'message', {
        role: 'assistant',
        text: lastAssistantMessage,
        metadata: { ...commonPayload(payload), final: true },
      }),
    );
  }
  events.push(event(payload, 'finished', {
    ok: true,
    subtype: 'success',
    stopReason: firstString(payload, ['stopReason', 'reason']) || undefined,
    backgroundTasks: firstValue(payload, ['backgroundTasks', 'background_tasks']),
    sessionCrons: firstValue(payload, ['sessionCrons', 'session_crons']),
    ...commonPayload(payload),
  }));
  return events;
}

export function translateGrokStopFailure(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent[] {
  const lastAssistantMessage =
    firstString(payload, ['lastAssistantMessage', 'lastMessage']) || undefined;
  const events: AgentEvent[] = [];
  if (lastAssistantMessage) {
    events.push(
      event(payload, 'message', {
        role: 'assistant',
        text: lastAssistantMessage,
        metadata: { ...commonPayload(payload), final: true },
      }),
    );
  }
  events.push(event(payload, 'finished', {
    ok: false,
    subtype: 'error',
    error:
      firstString(payload, ['error', 'errorMessage', 'message'], 'Grok turn failed'),
    errorDetails:
      firstString(payload, ['errorDetails', 'error_details']) || undefined,
    ...commonPayload(payload),
  }));
  return events;
}

export function translateGrokSessionEnd(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'session-end', {
    ...commonPayload(payload),
    reason: firstString(payload, ['reason']) || undefined,
  });
}
