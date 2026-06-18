import type { AgentEvent } from '@shared/types';

const AGENT_ID = 'codex-cli';

interface BaseCodexHookPayload {
  session_id: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  turn_id?: string;
}

type AnyRecord = Record<string, unknown>;

function commonPayload(p: BaseCodexHookPayload): Record<string, unknown> {
  return {
    cwd: p.cwd,
    transcriptPath: p.transcript_path ?? undefined,
    hookEventName: p.hook_event_name,
    model: p.model,
    turnId: p.turn_id,
  };
}

function event<P>(p: BaseCodexHookPayload, kind: AgentEvent<P>['kind'], payload: P): AgentEvent<P> {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind,
    payload,
    ts: Date.now(),
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
    permissionMode: p.permission_mode,
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
    tool_use_id?: string;
    permission_mode?: string;
  },
): AgentEvent {
  const tool = p.tool_name || 'tool';
  return event(p, 'waiting-for-user', {
    type: 'codex-terminal-permission-request',
    message: `Codex is waiting for terminal approval: ${tool}`,
    ...commonPayload(p),
    toolName: p.tool_name,
    toolInput: p.tool_input,
    toolUseId: p.tool_use_id,
    permissionMode: p.permission_mode,
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
): AgentEvent {
  return event(p, 'finished', {
    ok: true,
    subtype: 'success',
    stopHookActive: p.stop_hook_active,
    lastAssistantMessage: p.last_assistant_message ?? undefined,
    ...commonPayload(p),
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
