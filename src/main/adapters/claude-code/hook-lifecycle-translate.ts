import type { AgentEvent } from '@shared/types';
import { buildClaudeCompactMessageText } from './compact-message';
import {
  type BaseClaudeHookPayload,
  claudeHookEvent,
  commonClaudeHookPayload,
} from './hook-context';

export function translateSessionStart(
  input: BaseClaudeHookPayload & {
    source?: string;
    model?: string;
    session_title?: string;
  },
): AgentEvent {
  return claudeHookEvent(input, 'session-start', {
    ...commonClaudeHookPayload(input),
    source: input.source,
    model: input.model,
    sessionTitle: input.session_title,
  });
}

export function translateUserPromptSubmit(
  input: BaseClaudeHookPayload & {
    prompt?: string;
    source?: string;
    session_title?: string;
  },
): AgentEvent {
  return claudeHookEvent(input, 'message', {
    role: 'user',
    text: input.prompt ?? '',
    metadata: {
      ...commonClaudeHookPayload(input),
      source: input.source,
      sessionTitle: input.session_title,
    },
  });
}

export function translatePreToolUse(
  input: BaseClaudeHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
  },
): AgentEvent {
  return claudeHookEvent(input, 'tool-use-start', {
    ...commonClaudeHookPayload(input),
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolUseId: input.tool_use_id,
  });
}

export function translatePermissionRequest(
  input: BaseClaudeHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    permission_suggestions?: unknown;
  },
): AgentEvent {
  const toolName = input.tool_name || 'tool';
  return claudeHookEvent(input, 'waiting-for-user', {
    type: 'claude-terminal-permission-request',
    message: `Claude is waiting for terminal approval: ${toolName}`,
    ...commonClaudeHookPayload(input),
    toolName: input.tool_name,
    toolInput: input.tool_input,
    permissionSuggestions: input.permission_suggestions,
  });
}

export function translatePostToolUseFailure(
  input: BaseClaudeHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    error?: string;
    is_interrupt?: boolean;
    duration_ms?: number;
  },
): AgentEvent {
  return claudeHookEvent(input, 'tool-use-end', {
    ...commonClaudeHookPayload(input),
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolUseId: input.tool_use_id,
    status: input.is_interrupt ? 'interrupted' : 'failed',
    error: input.error,
    isInterrupt: input.is_interrupt,
    durationMs: input.duration_ms,
  });
}

export function translatePermissionDenied(
  input: BaseClaudeHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    reason?: string;
  },
): AgentEvent {
  return claudeHookEvent(input, 'tool-use-end', {
    ...commonClaudeHookPayload(input),
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolUseId: input.tool_use_id,
    status: 'denied',
    error: input.reason,
    reason: input.reason,
  });
}

const ACTION_REQUIRED_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
]);

export function translateNotification(
  input: BaseClaudeHookPayload & {
    message?: string;
    title?: string;
    notification_type?: string;
  },
): AgentEvent {
  const common = commonClaudeHookPayload(input);
  const notificationType = input.notification_type;
  if (!notificationType || ACTION_REQUIRED_NOTIFICATIONS.has(notificationType)) {
    return claudeHookEvent(input, 'waiting-for-user', {
      ...common,
      type: notificationType ?? 'claude-terminal-notification',
      title: input.title,
      message: input.message,
    });
  }
  return claudeHookEvent(input, 'message', {
    role: 'assistant',
    text: input.message ?? input.title ?? 'Claude notification',
    metadata: {
      ...common,
      notification: true,
      notificationType,
      title: input.title,
    },
  });
}

function finalTurnEvents(
  input: BaseClaudeHookPayload,
  lastAssistantMessage: string | undefined,
  finishedPayload: Record<string, unknown>,
): AgentEvent[] {
  const ts = Date.now();
  const events: AgentEvent[] = [];
  if (lastAssistantMessage) {
    events.push(
      claudeHookEvent(
        input,
        'message',
        {
          role: 'assistant',
          text: lastAssistantMessage,
          metadata: { ...commonClaudeHookPayload(input), final: true },
        },
        ts,
      ),
    );
  }
  events.push(claudeHookEvent(input, 'finished', finishedPayload, ts));
  return events;
}

export function translateStop(
  input: BaseClaudeHookPayload & {
    stop_hook_active?: boolean;
    last_assistant_message?: string;
    background_tasks?: unknown;
    session_crons?: unknown;
  },
): AgentEvent[] {
  return finalTurnEvents(input, input.last_assistant_message, {
    ...commonClaudeHookPayload(input),
    ok: true,
    subtype: 'success',
    stopHookActive: input.stop_hook_active,
    backgroundTasks: input.background_tasks,
    sessionCrons: input.session_crons,
  });
}

export function translateStopFailure(
  input: BaseClaudeHookPayload & {
    error?: unknown;
    error_details?: string;
    last_assistant_message?: string;
  },
): AgentEvent[] {
  return finalTurnEvents(input, input.last_assistant_message, {
    ...commonClaudeHookPayload(input),
    ok: false,
    subtype: 'error',
    error: input.error,
    errorDetails: input.error_details,
  });
}

export function translateSessionEnd(
  input: BaseClaudeHookPayload & { reason?: string },
): AgentEvent {
  return claudeHookEvent(input, 'session-end', {
    ...commonClaudeHookPayload(input),
    reason: input.reason,
  });
}

export function translatePostCompact(
  input: BaseClaudeHookPayload & {
    trigger?: string;
    compact_summary?: string;
  },
): AgentEvent {
  return claudeHookEvent(input, 'message', {
    ...commonClaudeHookPayload(input),
    role: 'assistant',
    text: buildClaudeCompactMessageText({
      trigger: input.trigger,
      summary: input.compact_summary,
    }),
  });
}
