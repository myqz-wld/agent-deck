import { describe, expect, it } from 'vitest';
import {
  translateMessageDisplay,
  translateNotification,
  translatePermissionDenied,
  translatePermissionRequest,
  translatePostCompact,
  translatePostToolUse,
  translatePostToolUseFailure,
  translatePreCompact,
  translatePreToolUse,
  translateStop,
  translateStopFailure,
  translateSubagentStart,
  translateSubagentStop,
  translateUserPromptSubmit,
} from '../translate';

const base = {
  session_id: 'claude-external-1',
  cwd: '/repo',
  transcript_path: '/tmp/claude.jsonl',
  prompt_id: 'prompt-1',
  permission_mode: 'default',
  agent_id: 'subagent-1',
  agent_type: 'code-reviewer',
  effort: { level: 'high' },
};

describe('Claude Code hook translation contract', () => {
  it('preserves tool ids and common context across successful tool lifecycle events', () => {
    expect(
      translatePreToolUse({
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'true' },
        tool_use_id: 'tool-1',
      }),
    ).toMatchObject({
      kind: 'tool-use-start',
      payload: {
        toolName: 'Bash',
        toolUseId: 'tool-1',
        transcriptPath: '/tmp/claude.jsonl',
        promptId: 'prompt-1',
        permissionMode: 'default',
        agentId: 'subagent-1',
        agentType: 'code-reviewer',
        effort: 'high',
      },
    });

    expect(
      translatePostToolUse({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'true' },
        tool_response: 'ok',
        tool_use_id: 'tool-1',
        duration_ms: 240,
      })[0],
    ).toMatchObject({
      kind: 'tool-use-end',
      payload: {
        toolName: 'Bash',
        toolUseId: 'tool-1',
        status: 'completed',
        durationMs: 240,
      },
    });
  });

  it('closes failed, interrupted, and denied tool calls with the provider id', () => {
    expect(
      translatePostToolUseFailure({
        ...base,
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        tool_use_id: 'tool-failed',
        error: 'exit 1',
        duration_ms: 500,
      }),
    ).toMatchObject({
      kind: 'tool-use-end',
      payload: {
        toolUseId: 'tool-failed',
        status: 'failed',
        error: 'exit 1',
        durationMs: 500,
      },
    });
    expect(
      translatePostToolUseFailure({
        ...base,
        tool_use_id: 'tool-interrupted',
        is_interrupt: true,
      }),
    ).toMatchObject({
      payload: { toolUseId: 'tool-interrupted', status: 'interrupted' },
    });
    expect(
      translatePermissionDenied({
        ...base,
        tool_name: 'Write',
        tool_use_id: 'tool-denied',
        reason: 'user rejected',
      }),
    ).toMatchObject({
      kind: 'tool-use-end',
      payload: {
        toolUseId: 'tool-denied',
        status: 'denied',
        error: 'user rejected',
      },
    });
  });

  it('captures user prompts and terminal permission requests without inventing a tool id', () => {
    expect(
      translateUserPromptSubmit({
        ...base,
        prompt: 'Review this branch.',
        source: 'user',
        session_title: 'Review',
      }),
    ).toMatchObject({
      kind: 'message',
      payload: {
        role: 'user',
        text: 'Review this branch.',
        metadata: { source: 'user', sessionTitle: 'Review' },
      },
    });
    expect(
      translatePermissionRequest({
        ...base,
        tool_name: 'Bash',
        tool_input: { command: 'sudo true' },
      }),
    ).toMatchObject({
      kind: 'waiting-for-user',
      payload: {
        type: 'claude-terminal-permission-request',
        toolName: 'Bash',
      },
    });
  });

  it('only turns action-required notifications into waiting state', () => {
    expect(
      translateNotification({
        ...base,
        message: 'Approve Bash',
        notification_type: 'permission_prompt',
      }).kind,
    ).toBe('waiting-for-user');
    expect(
      translateNotification({
        ...base,
        message: 'Authentication succeeded',
        notification_type: 'auth_success',
      }),
    ).toMatchObject({
      kind: 'message',
      payload: {
        role: 'assistant',
        text: 'Authentication succeeded',
        metadata: { notificationType: 'auth_success' },
      },
    });
  });

  it('preserves display, compaction, and subagent lifecycle events', () => {
    expect(
      translateMessageDisplay({
        ...base,
        turn_id: 'turn-1',
        message_id: 'display-1',
        index: 2,
        final: true,
        delta: 'final line',
      }),
    ).toMatchObject({
      kind: 'message-display',
      payload: {
        role: 'assistant',
        turnId: 'turn-1',
        messageId: 'display-1',
        index: 2,
        final: true,
        delta: 'final line',
      },
    });
    expect(
      translatePreCompact({
        ...base,
        trigger: 'manual',
        custom_instructions: 'Keep validation evidence.',
      }),
    ).toMatchObject({
      kind: 'context-compaction-start',
      payload: {
        trigger: 'manual',
        customInstructions: 'Keep validation evidence.',
      },
    });
    expect(
      translatePostCompact({
        ...base,
        trigger: 'manual',
        compact_summary: 'Validation evidence retained.',
      }),
    ).toMatchObject({
      kind: 'context-compaction-end',
      payload: {
        trigger: 'manual',
        summary: 'Validation evidence retained.',
      },
    });
    expect(translateSubagentStart(base)).toMatchObject({
      kind: 'subagent-start',
      payload: { subagentId: 'subagent-1', subagentType: 'code-reviewer' },
    });
    expect(
      translateSubagentStop({
        ...base,
        agent_transcript_path: '/tmp/subagent.jsonl',
        stop_hook_active: false,
        last_assistant_message: 'No blockers.',
      }),
    ).toMatchObject({
      kind: 'subagent-end',
      payload: {
        subagentId: 'subagent-1',
        subagentType: 'code-reviewer',
        agentTranscriptPath: '/tmp/subagent.jsonl',
        stopHookActive: false,
        lastAssistantMessage: 'No blockers.',
      },
    });
  });

  it('emits final assistant text before successful and failed terminal events', () => {
    expect(
      translateStop({
        ...base,
        last_assistant_message: 'Done.',
        background_tasks: [{ id: 'bg-1' }],
      }),
    ).toMatchObject([
      { kind: 'message', payload: { role: 'assistant', text: 'Done.' } },
      {
        kind: 'finished',
        payload: { ok: true, backgroundTasks: [{ id: 'bg-1' }] },
      },
    ]);
    expect(
      translateStopFailure({
        ...base,
        error: 'model_error',
        error_details: 'upstream failed',
        last_assistant_message: 'Partial answer.',
      }),
    ).toMatchObject([
      {
        kind: 'message',
        payload: { role: 'assistant', text: 'Partial answer.' },
      },
      {
        kind: 'finished',
        payload: {
          ok: false,
          error: 'model_error',
          errorDetails: 'upstream failed',
        },
      },
    ]);
  });
});
