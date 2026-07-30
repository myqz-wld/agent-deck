import { describe, expect, it } from 'vitest';
import {
  translateCodexPermissionRequest,
  translateCodexPostCompact,
  translateCodexPostToolUse,
  translateCodexPreCompact,
  translateCodexPreToolUse,
  translateCodexSessionEnd,
  translateCodexSessionStart,
  translateCodexStop,
  translateCodexSubagentStart,
  translateCodexSubagentStop,
  translateCodexUnclosedToolUses,
  translateCodexUserPrompt,
} from '../hook-translate';

describe('Codex CLI hook translation', () => {
  it('translates SessionStart as a Codex CLI session-start event', () => {
    const event = translateCodexSessionStart({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      transcript_path: '/tmp/transcript.jsonl',
      hook_event_name: 'SessionStart',
      model: 'gpt-5.5',
      source: 'startup',
      permission_mode: 'default',
      agent_type: 'code-reviewer',
    });

    expect(event).toMatchObject({
      sessionId: 'codex-sid-1',
      agentId: 'codex-cli',
      kind: 'session-start',
      payload: {
        cwd: '/repo',
        transcriptPath: '/tmp/transcript.jsonl',
        hookEventName: 'SessionStart',
        model: 'gpt-5.5',
        source: 'startup',
        permissionMode: 'default',
        agentType: 'code-reviewer',
      },
    });
  });

  it('translates PreToolUse with tool id and input', () => {
    const event = translateCodexPreToolUse({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tool-1',
      turn_id: 'turn-1',
    });

    expect(event.kind).toBe('tool-use-start');
    expect(event.payload).toMatchObject({
      cwd: '/repo',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolUseId: 'tool-1',
      turnId: 'turn-1',
    });
  });

  it('translates PermissionRequest as a terminal-only waiting state', () => {
    const event = translateCodexPermissionRequest({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'sudo true' },
      permission_mode: 'default',
    });

    expect(event.kind).toBe('waiting-for-user');
    expect(event.payload).toMatchObject({
      type: 'codex-terminal-permission-request',
      message: 'Codex is waiting for terminal approval: Bash',
      toolName: 'Bash',
      toolInput: { command: 'sudo true' },
      permissionMode: 'default',
    });
  });

  it('marks PostToolUse completed even when the command response has a non-zero exit code', () => {
    const event = translateCodexPostToolUse({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { exit_code: 1, output: 'nope' },
      tool_use_id: 'tool-3',
    });

    expect(event.kind).toBe('tool-use-end');
    expect(event.payload).toMatchObject({
      toolName: 'Bash',
      toolInput: { command: 'false' },
      toolResult: { exit_code: 1, output: 'nope' },
      toolUseId: 'tool-3',
      status: 'completed',
    });
  });

  it('translates user prompts, compaction, Stop, and SessionEnd', () => {
    const prompt = translateCodexUserPrompt({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      prompt: 'Review this branch.',
      turn_id: 'turn-2',
    });
    const preCompact = translateCodexPreCompact({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      trigger: 'auto',
      turn_id: 'turn-2',
    });
    const postCompact = translateCodexPostCompact({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      trigger: 'auto',
      turn_id: 'turn-2',
    });
    const stopEvents = translateCodexStop({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      stop_hook_active: false,
      last_assistant_message: 'done',
      turn_id: 'turn-2',
    });
    const sessionEnd = translateCodexSessionEnd({
      session_id: 'codex-sid-1',
      cwd: '/repo',
      reason: 'other',
    });

    expect(prompt).toMatchObject({
      kind: 'message',
      payload: { role: 'user', text: 'Review this branch.' },
    });
    expect(preCompact).toMatchObject({
      kind: 'context-compaction-start',
      payload: { trigger: 'auto', turnId: 'turn-2' },
    });
    expect(postCompact).toMatchObject({
      kind: 'context-compaction-end',
      payload: {
        trigger: 'auto',
      text: 'Codex context compacted (auto)',
      },
    });
    expect(stopEvents).toMatchObject([
      {
        kind: 'message',
        payload: { role: 'assistant', text: 'done' },
      },
      {
        kind: 'finished',
        payload: {
          ok: true,
          subtype: 'success',
          stopHookActive: false,
          turnId: 'turn-2',
          clearsTerminalPermission: true,
        },
      },
    ]);
    expect(sessionEnd).toMatchObject({
      kind: 'session-end',
      payload: { reason: 'other', clearsTerminalPermission: true },
    });
  });

  it('preserves subagent lifecycle metadata', () => {
    expect(
      translateCodexSubagentStart({
        session_id: 'codex-sid-1',
        turn_id: 'turn-3',
        agent_id: 'agent-7',
        agent_type: 'reviewer',
      }),
    ).toMatchObject({
      kind: 'subagent-start',
      payload: {
        subagentId: 'agent-7',
        subagentType: 'reviewer',
        turnId: 'turn-3',
      },
    });
    expect(
      translateCodexSubagentStop({
        session_id: 'codex-sid-1',
        turn_id: 'turn-3',
        agent_id: 'agent-7',
        agent_type: 'reviewer',
        agent_transcript_path: '/tmp/agent-7.jsonl',
        stop_hook_active: false,
        last_assistant_message: 'No blockers.',
      }),
    ).toMatchObject({
      kind: 'subagent-end',
      payload: {
        subagentId: 'agent-7',
        subagentType: 'reviewer',
        agentTranscriptPath: '/tmp/agent-7.jsonl',
        stopHookActive: false,
        lastAssistantMessage: 'No blockers.',
      },
    });
  });

  it('closes unmatched tool starts conservatively at a terminal hook', () => {
    expect(
      translateCodexUnclosedToolUses(
        { session_id: 'codex-sid-1', turn_id: 'turn-4' },
        [
          {
            toolUseId: 'tool-open',
            toolName: 'Bash',
            toolInput: { command: 'sleep 10' },
          },
        ],
        'Stop',
      ),
    ).toMatchObject([
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'tool-open',
          toolName: 'Bash',
          status: 'aborted',
          terminalHook: 'Stop',
          terminalReason: 'turn-ended-without-post-tool-use',
          clearsTerminalPermission: true,
        },
      },
    ]);
  });
});
