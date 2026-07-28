import type { AgentEvent } from '@shared/types';

export const CLAUDE_AGENT_ID = 'claude-code';

export interface BaseClaudeHookPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt_id?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  effort?: { level?: string };
}

export function commonClaudeHookPayload(
  payload: BaseClaudeHookPayload,
): Record<string, unknown> {
  return {
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
    hookEventName: payload.hook_event_name,
    promptId: payload.prompt_id,
    permissionMode: payload.permission_mode,
    agentId: payload.agent_id,
    agentType: payload.agent_type,
    effort: payload.effort?.level,
  };
}

export function claudeHookEvent<P>(
  input: BaseClaudeHookPayload,
  kind: AgentEvent<P>['kind'],
  payload: P,
  ts = Date.now(),
): AgentEvent<P> {
  return {
    sessionId: input.session_id,
    agentId: CLAUDE_AGENT_ID,
    kind,
    payload,
    ts,
  };
}
