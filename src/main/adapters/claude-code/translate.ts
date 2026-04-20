import type { AgentEvent } from '@shared/types';

const AGENT_ID = 'claude-code';

/**
 * Claude Code hook payload 格式（来自 Claude Code 文档 + 实测）：
 *
 * - SessionStart:    { session_id, transcript_path, cwd, source }
 * - PreToolUse:      { session_id, transcript_path, cwd, tool_name, tool_input }
 * - PostToolUse:     { session_id, transcript_path, cwd, tool_name, tool_input, tool_response }
 * - Notification:    { session_id, transcript_path, cwd, message }
 * - Stop:            { session_id, transcript_path, cwd, stop_hook_active }
 * - SessionEnd:      { session_id, transcript_path, cwd, reason }
 *
 * 我们把它们翻译为统一的 AgentEvent。
 */

interface BaseHookPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
}

export function translateSessionStart(p: BaseHookPayload & { source?: string }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'session-start',
    payload: { cwd: p.cwd, transcriptPath: p.transcript_path, source: p.source },
    ts: Date.now(),
  };
}

export function translatePreToolUse(
  p: BaseHookPayload & { tool_name?: string; tool_input?: unknown },
): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'tool-use-start',
    payload: { cwd: p.cwd, toolName: p.tool_name, toolInput: p.tool_input },
    ts: Date.now(),
  };
}

interface EditToolInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

interface WriteToolInput {
  file_path?: string;
  content?: string;
}

interface MultiEditToolInput {
  file_path?: string;
  edits?: { old_string: string; new_string: string }[];
}

/**
 * PostToolUse 翻译。如果 tool_name 是 Edit/Write/MultiEdit，会同时返回
 * 一个 file-changed 事件（包含 before/after）。
 */
export function translatePostToolUse(
  p: BaseHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
  },
): AgentEvent[] {
  const ts = Date.now();
  const events: AgentEvent[] = [
    {
      sessionId: p.session_id,
      agentId: AGENT_ID,
      kind: 'tool-use-end',
      payload: {
        cwd: p.cwd,
        toolName: p.tool_name,
        toolInput: p.tool_input,
        toolResponse: p.tool_response,
      },
      ts,
    },
  ];

  if (!p.tool_name) return events;

  if (p.tool_name === 'Edit') {
    const input = p.tool_input as EditToolInput;
    if (input?.file_path) {
      events.push({
        sessionId: p.session_id,
        agentId: AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before: input.old_string ?? null,
          after: input.new_string ?? null,
          metadata: { source: 'Edit' },
        },
        ts,
      });
    }
  } else if (p.tool_name === 'Write') {
    const input = p.tool_input as WriteToolInput;
    if (input?.file_path) {
      events.push({
        sessionId: p.session_id,
        agentId: AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before: null, // Write 不携带 before；UI 渲染时可标记为「新文件」
          after: input.content ?? null,
          metadata: { source: 'Write' },
        },
        ts,
      });
    }
  } else if (p.tool_name === 'MultiEdit') {
    const input = p.tool_input as MultiEditToolInput;
    if (input?.file_path && Array.isArray(input.edits)) {
      // 把多条 edits 合成 before/after：依次拼接每条 edit 的方向
      const before = input.edits.map((e) => e.old_string).join('\n---\n');
      const after = input.edits.map((e) => e.new_string).join('\n---\n');
      events.push({
        sessionId: p.session_id,
        agentId: AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before,
          after,
          metadata: { source: 'MultiEdit', editCount: input.edits.length },
        },
        ts,
      });
    }
  }

  return events;
}

export function translateNotification(p: BaseHookPayload & { message?: string }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'waiting-for-user',
    payload: { cwd: p.cwd, message: p.message },
    ts: Date.now(),
  };
}

export function translateStop(p: BaseHookPayload & { stop_hook_active?: boolean }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'finished',
    payload: { cwd: p.cwd, stopHookActive: p.stop_hook_active },
    ts: Date.now(),
  };
}

export function translateSessionEnd(p: BaseHookPayload & { reason?: string }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'session-end',
    payload: { cwd: p.cwd, reason: p.reason },
    ts: Date.now(),
  };
}
