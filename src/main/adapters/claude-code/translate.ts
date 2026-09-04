import type { AgentEvent } from '@shared/types';
import {
  type BaseClaudeHookPayload,
  CLAUDE_AGENT_ID,
  commonClaudeHookPayload,
} from './hook-context';

export * from './hook-lifecycle-translate';

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
 *
 * The current Claude hook contract requires `tool_use_id` for PostToolUse events, and text file
 * changes preserve it for reverse lookup from the persisted change to its tool call.
 */
export function translatePostToolUse(
  p: BaseClaudeHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    tool_use_id: string;
    duration_ms?: number;
  },
): AgentEvent[] {
  const ts = Date.now();
  const events: AgentEvent[] = [
    {
      sessionId: p.session_id,
      agentId: CLAUDE_AGENT_ID,
      kind: 'tool-use-end',
      payload: {
        ...commonClaudeHookPayload(p),
        toolName: p.tool_name,
        toolInput: p.tool_input,
        toolResponse: p.tool_response,
        toolUseId: p.tool_use_id,
        status: 'completed',
        durationMs: p.duration_ms,
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
        agentId: CLAUDE_AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before: input.old_string ?? null,
          after: input.new_string ?? null,
          metadata: { source: 'Edit' },
          toolCallId: p.tool_use_id,
        },
        ts,
      });
    }
  } else if (p.tool_name === 'Write') {
    const input = p.tool_input as WriteToolInput;
    if (input?.file_path) {
      events.push({
        sessionId: p.session_id,
        agentId: CLAUDE_AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before: null, // Write 不携带 before；UI 渲染时可标记为「新文件」
          after: input.content ?? null,
          metadata: { source: 'Write' },
          toolCallId: p.tool_use_id,
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
        agentId: CLAUDE_AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before,
          after,
          metadata: { source: 'MultiEdit', editCount: input.edits.length },
          toolCallId: p.tool_use_id,
        },
        ts,
      });
    }
  }

  return events;
}
