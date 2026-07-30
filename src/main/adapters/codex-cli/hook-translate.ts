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
    // Codex emits PostToolUse only for the successful lifecycle branch. A command's
    // non-zero exit code is still a completed tool response, not a missing/failing hook.
    status: 'completed',
    clearsTerminalPermission: true,
  });
}

export function translateCodexPreCompact(
  p: BaseCodexHookPayload & {
    trigger?: string;
  },
): AgentEvent {
  return event(p, 'context-compaction-start', {
    ...commonPayload(p),
    trigger: p.trigger,
  });
}

export function translateCodexPostCompact(
  p: BaseCodexHookPayload & {
    trigger?: string;
  },
): AgentEvent {
  return event(p, 'context-compaction-end', {
    ...commonPayload(p),
    trigger: p.trigger,
    text: `Codex context compacted${p.trigger ? ` (${p.trigger})` : ''}`,
  });
}

export function translateCodexSubagentStart(
  p: BaseCodexHookPayload & {
    agent_id?: string;
    agent_type?: string;
  },
): AgentEvent {
  return event(p, 'subagent-start', {
    ...commonPayload(p),
    subagentId: p.agent_id,
    subagentType: p.agent_type,
  });
}

export function translateCodexSubagentStop(
  p: BaseCodexHookPayload & {
    stop_hook_active?: boolean;
    agent_id?: string;
    agent_type?: string;
    agent_transcript_path?: string | null;
    last_assistant_message?: string | null;
  },
): AgentEvent {
  return event(p, 'subagent-end', {
    ...commonPayload(p),
    subagentId: p.agent_id,
    subagentType: p.agent_type,
    agentTranscriptPath: p.agent_transcript_path ?? undefined,
    stopHookActive: p.stop_hook_active,
    lastAssistantMessage: p.last_assistant_message ?? undefined,
  });
}

export interface CodexOpenToolUse {
  toolUseId: string;
  toolName?: unknown;
  toolInput?: unknown;
}

export function translateCodexUnclosedToolUses(
  p: BaseCodexHookPayload,
  openTools: CodexOpenToolUse[],
  terminalHook: 'Stop' | 'SessionEnd',
): AgentEvent[] {
  const ts = Date.now();
  return openTools.map((tool) =>
    event(p, 'tool-use-end', {
      ...commonPayload(p),
      toolName: tool.toolName,
      toolInput: tool.toolInput,
      toolUseId: tool.toolUseId,
      status: 'aborted',
      terminalHook,
      terminalReason: 'turn-ended-without-post-tool-use',
      clearsTerminalPermission: true,
    }, ts),
  );
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
      clearsTerminalPermission: true,
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
    clearsTerminalPermission: true,
  });
}
