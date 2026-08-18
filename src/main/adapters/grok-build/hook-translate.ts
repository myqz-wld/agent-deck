import type { AgentEvent } from '@shared/types';

const AGENT_ID = 'grok-build';

export interface BaseGrokHookPayload {
  sessionId: string;
  cwd?: string;
  workspaceRoot?: string;
  hookEventName?: string;
  modelId?: string;
  timestamp?: string | number;
  transcriptPath?: string;
  permissionMode?: string;
  promptId?: string;
  subagentType?: string;
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

function stringField(payload: AnyRecord, key: string, fallback = ''): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function rawStringField(payload: AnyRecord, key: string, fallback = ''): string {
  const value = payload[key];
  return typeof value === 'string' ? value : fallback;
}

function numberField(payload: AnyRecord, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(payload: AnyRecord, key: string): boolean | undefined {
  const value = payload[key];
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
    model: stringField(payload, 'modelId') || undefined,
    timestamp: payload.timestamp,
    transcriptPath: stringField(payload, 'transcriptPath') || undefined,
    permissionMode: stringField(payload, 'permissionMode') || undefined,
    promptId: stringField(payload, 'promptId') || undefined,
    subagentType: stringField(payload, 'subagentType') || undefined,
  };
}

function toolFields(payload: BaseGrokHookPayload & AnyRecord): Record<string, unknown> {
  return {
    toolName: stringField(payload, 'toolName') || undefined,
    toolInput: payload.toolInput,
    toolUseId: stringField(payload, 'toolUseId') || undefined,
    toolInputTruncated: booleanField(payload, 'toolInputTruncated'),
    toolResultTruncated: booleanField(payload, 'toolResultTruncated'),
    durationMs: numberField(payload, 'durationMs'),
    isBackgrounded: booleanField(payload, 'isBackgrounded'),
  };
}

export interface GrokPromptNormalization {
  text: string;
  rawText: string;
  normalizedBy?: 'grok-user-query-envelope-v1';
}

/**
 * Grok Build's normal interactive path wraps the submitted text in one canonical outer envelope:
 * `<user_query>\n...\n</user_query>`. Strip exactly that single provider-owned layer for display.
 *
 * The transform is deliberately anchored, non-recursive, and newline-sensitive:
 * - nested tags typed by the user remain intact after the outer layer is removed;
 * - malformed/sibling/prefixed content is preserved verbatim;
 * - rawText is always retained because Grok Build's `--verbatim` path exposes no provenance bit, so a
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
    source: stringField(payload, 'source') || undefined,
  });
}

export function translateGrokUserPrompt(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  const rawText = rawStringField(
    payload,
    'prompt',
    'Grok Build 提示已提交',
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
    toolResult: payload.toolResult,
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
    error: stringField(payload, 'error', 'Grok Build 工具调用失败'),
    errorDetails: stringField(payload, 'errorDetails') || undefined,
  });
}

export function translateGrokPermissionDenied(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'tool-use-end', {
    ...commonPayload(payload),
    ...toolFields(payload),
    status: 'denied',
    error: stringField(payload, 'reason', 'Grok Build 工具权限被拒绝'),
  });
}

export function translateGrokPreCompact(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'context-compaction-start', {
    ...commonPayload(payload),
    trigger: stringField(payload, 'trigger') || undefined,
    source: stringField(payload, 'source') || undefined,
    customInstructions: stringField(payload, 'customInstructions') || undefined,
  });
}

export function translateGrokPostCompact(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  const trigger = stringField(payload, 'trigger');
  const summary = stringField(payload, 'compactSummary') || undefined;
  return event(payload, 'context-compaction-end', {
    ...commonPayload(payload),
    trigger: trigger || undefined,
    source: stringField(payload, 'source') || undefined,
    summary,
    text: `Grok Build 上下文已压缩${trigger ? `（${trigger}）` : ''}`,
  });
}

export function translateGrokSubagentStart(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'subagent-start', {
    ...commonPayload(payload),
    subagentId: stringField(payload, 'subagentId') || undefined,
    subagentType: stringField(payload, 'subagentType') || undefined,
    description: stringField(payload, 'description') || undefined,
  });
}

export function translateGrokSubagentStop(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'subagent-end', {
    ...commonPayload(payload),
    subagentId: stringField(payload, 'subagentId') || undefined,
    subagentType: stringField(payload, 'subagentType') || undefined,
    phase: stringField(payload, 'phase') || undefined,
    stopHookActive: booleanField(payload, 'stopHookActive'),
    lastAssistantMessage: stringField(payload, 'lastAssistantMessage') || undefined,
  });
}

export function translateGrokNotification(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  const notificationType = stringField(payload, 'notificationType') || undefined;
  const title = stringField(payload, 'title') || undefined;
  const message = stringField(payload, 'message', title ?? 'Grok Build 通知');
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
        level: stringField(payload, 'level') || undefined,
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
  const lastAssistantMessage = stringField(payload, 'lastAssistantMessage') || undefined;
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
    stopReason: stringField(payload, 'reason') || undefined,
    backgroundTasks: payload.backgroundTasks,
    sessionCrons: payload.sessionCrons,
    ...commonPayload(payload),
  }));
  return events;
}

export function translateGrokStopFailure(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent[] {
  const lastAssistantMessage = stringField(payload, 'lastAssistantMessage') || undefined;
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
    error: stringField(payload, 'error', 'Grok Build 轮次失败'),
    errorDetails: stringField(payload, 'errorDetails') || undefined,
    ...commonPayload(payload),
  }));
  return events;
}

export function translateGrokSessionEnd(
  payload: BaseGrokHookPayload & AnyRecord,
): AgentEvent {
  return event(payload, 'session-end', {
    ...commonPayload(payload),
    reason: stringField(payload, 'reason') || undefined,
  });
}
