import type { AgentEvent } from '@shared/types';

const AGENT_ID = 'grok-build';

export interface BaseGrokHookPayload {
  sessionId: string;
  cwd?: string;
  workspaceRoot?: string;
  hookEventName?: string;
  model?: string;
}

type AnyRecord = Record<string, unknown>;

function commonPayload(payload: BaseGrokHookPayload): Record<string, unknown> {
  return {
    cwd: payload.cwd,
    workspaceRoot: payload.workspaceRoot,
    hookEventName: payload.hookEventName,
    model: payload.model,
  };
}

function event<P>(
  payload: BaseGrokHookPayload,
  kind: AgentEvent<P>['kind'],
  value: P,
): AgentEvent<P> {
  return {
    sessionId: payload.sessionId,
    agentId: AGENT_ID,
    kind,
    payload: value,
    ts: Date.now(),
  };
}

function firstString(payload: AnyRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

function firstValue(payload: AnyRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key];
  }
  return undefined;
}

function toolFields(payload: BaseGrokHookPayload & AnyRecord): Record<string, unknown> {
  return {
    toolName: firstString(payload, ['toolName', 'tool_name']) || undefined,
    toolInput: firstValue(payload, ['toolInput', 'tool_input']),
    toolUseId:
      firstString(payload, ['toolUseId', 'toolCallId', 'tool_use_id']) || undefined,
  };
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
  const text = firstString(
    payload,
    ['prompt', 'userPrompt', 'message'],
    'Grok prompt submitted',
  );
  return event(payload, 'message', {
    role: 'user',
    text,
    metadata: commonPayload(payload),
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
      'toolOutput',
      'toolResponse',
      'toolResult',
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
  return event(payload, 'waiting-for-user', {
    type: 'grok-terminal-notification',
    message:
      firstString(payload, ['message', 'title'], 'Grok is waiting for terminal input'),
    ...commonPayload(payload),
  });
}

export function translateGrokStop(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'finished', {
    ok: true,
    subtype: 'success',
    stopReason: firstString(payload, ['stopReason', 'reason']) || undefined,
    lastAssistantMessage:
      firstString(payload, ['lastAssistantMessage', 'lastMessage']) || undefined,
    ...commonPayload(payload),
  });
}

export function translateGrokStopFailure(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'finished', {
    ok: false,
    subtype: 'error',
    error:
      firstString(payload, ['error', 'errorMessage', 'message'], 'Grok turn failed'),
    ...commonPayload(payload),
  });
}

export function translateGrokSessionEnd(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'session-end', {
    ...commonPayload(payload),
    reason: firstString(payload, ['reason']) || undefined,
  });
}
