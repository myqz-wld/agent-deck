import type { AgentEvent } from '@shared/types';

const AGENT_ID = 'codex-cli';

interface BaseCodexHookPayload {
  session_id: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  turn_id?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
}

type AnyRecord = Record<string, unknown>;

function commonPayload(p: BaseCodexHookPayload): Record<string, unknown> {
  return {
    cwd: p.cwd,
    transcriptPath: p.transcript_path ?? undefined,
    hookEventName: p.hook_event_name,
    model: p.model,
    turnId: p.turn_id,
    permissionMode: p.permission_mode,
    agentId: p.agent_id,
    agentType: p.agent_type,
  };
}

function event<P>(
  p: BaseCodexHookPayload,
  kind: AgentEvent<P>['kind'],
  payload: P,
  ts = Date.now(),
): AgentEvent<P> {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind,
    payload,
    ts,
  };
}

export function translateCodexSessionStart(
  p: BaseCodexHookPayload & {
    source?: string;
    permission_mode?: string;
  },
): AgentEvent {
  return event(p, 'session-start', {
    ...commonPayload(p),
    source: p.source,
  });
}

export function translateCodexUserPrompt(
  p: BaseCodexHookPayload & { prompt?: string },
): AgentEvent {
  return event(p, 'message', {
    role: 'user',
    text: p.prompt ?? '',
    metadata: commonPayload(p),
  });
}

export function translateCodexPreToolUse(
  p: BaseCodexHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
  },
): AgentEvent {
  return event(p, 'tool-use-start', {
    ...commonPayload(p),
    toolName: p.tool_name,
    toolInput: p.tool_input,
    toolUseId: p.tool_use_id,
  });
}

export function translateCodexPermissionRequest(
  p: BaseCodexHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
  },
): AgentEvent {
  const tool = p.tool_name || 'tool';
  return event(p, 'waiting-for-user', {
    type: 'codex-terminal-permission-request',
    message: `Codex is waiting for terminal approval: ${tool}`,
    ...commonPayload(p),
    toolName: p.tool_name,
    toolInput: p.tool_input,
  });
}

export function translateCodexPostToolUse(
  p: BaseCodexHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    tool_use_id?: string;
  },
): AgentEvent {
  return event(p, 'tool-use-end', {
    ...commonPayload(p),
    toolName: p.tool_name,
    toolInput: p.tool_input,
    toolResult: p.tool_response,
    toolUseId: p.tool_use_id,
    status: codexToolStatus(p.tool_response),
    clearsTerminalPermission: true,
  });
}

export function translateCodexPostCompact(
  p: BaseCodexHookPayload & {
    trigger?: string;
  },
): AgentEvent {
  return event(p, 'message', {
    role: 'assistant',
    text: `Codex context compacted${p.trigger ? ` (${p.trigger})` : ''}`,
    metadata: commonPayload(p),
  });
}

export function translateCodexStop(
  p: BaseCodexHookPayload & {
    stop_hook_active?: boolean;
    last_assistant_message?: string | null;
  },
): AgentEvent[] {
  const ts = Date.now();
  const events: AgentEvent[] = [];
  if (p.last_assistant_message) {
    events.push(
      event(p, 'message', {
        role: 'assistant',
        text: p.last_assistant_message,
        metadata: { ...commonPayload(p), final: true },
      }, ts),
    );
  }
  events.push(
    event(p, 'finished', {
      ok: true,
      subtype: 'success',
      stopHookActive: p.stop_hook_active,
      ...commonPayload(p),
    }, ts),
  );
  return events;
}

export function translateCodexSessionEnd(
  p: BaseCodexHookPayload & { reason?: string },
): AgentEvent {
  return event(p, 'session-end', {
    ...commonPayload(p),
    reason: p.reason,
  });
}

function codexToolStatus(response: unknown): string | undefined {
  const record = asRecord(response);
  const status = stringField(record?.status);
  if (status) return status;
  const exitCode = numberField(record?.exit_code ?? record?.exitCode);
  if (exitCode === null) return undefined;
  return exitCode === 0 ? 'completed' : 'failed';
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
