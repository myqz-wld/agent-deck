import { describe, expect, it } from 'vitest';
import {
  translateGrokNotification,
  translateGrokPermissionDenied,
  translateGrokPostCompact,
  translateGrokPostToolUse,
  translateGrokPostToolUseFailure,
  translateGrokPreToolUse,
  translateGrokSessionEnd,
  translateGrokSessionStart,
  translateGrokStop,
  translateGrokStopFailure,
  translateGrokUserPrompt,
} from '../hook-translate';

const base = {
  sessionId: 'grok-external-1',
  cwd: '/repo',
  workspaceRoot: '/repo',
  hookEventName: 'SessionStart',
  model: 'grok-4.5',
};

describe('Grok hook translation', () => {
  it('maps session start and user prompts to grok-build events', () => {
    expect(translateGrokSessionStart({ ...base, source: 'startup' })).toMatchObject({
      sessionId: 'grok-external-1',
      agentId: 'grok-build',
      kind: 'session-start',
      payload: {
        cwd: '/repo',
        workspaceRoot: '/repo',
        model: 'grok-4.5',
        source: 'startup',
      },
    });
    expect(
      translateGrokUserPrompt({
        ...base,
        hookEventName: 'UserPromptSubmit',
        prompt: 'inspect this repository',
      }),
    ).toMatchObject({
      kind: 'message',
      payload: { role: 'user', text: 'inspect this repository' },
    });
  });

  it('maps tool start, success, failure, and permission denial', () => {
    const tool = {
      ...base,
      toolName: 'Bash',
      toolInput: { command: 'false' },
      toolUseId: 'tool-1',
    };
    expect(translateGrokPreToolUse(tool)).toMatchObject({
      kind: 'tool-use-start',
      payload: { toolName: 'Bash', toolUseId: 'tool-1' },
    });
    expect(
      translateGrokPostToolUse({ ...tool, toolOutput: { exitCode: 0 } }),
    ).toMatchObject({
      kind: 'tool-use-end',
      payload: { status: 'completed', toolResult: { exitCode: 0 } },
    });
    expect(
      translateGrokPostToolUseFailure({ ...tool, errorMessage: 'exit 1' }),
    ).toMatchObject({
      kind: 'tool-use-end',
      payload: { status: 'failed', error: 'exit 1' },
    });
    expect(
      translateGrokPermissionDenied({ ...tool, reason: 'user rejected' }),
    ).toMatchObject({
      kind: 'tool-use-end',
      payload: { status: 'denied', error: 'user rejected' },
    });
  });

  it('maps compact, notification, stop outcomes, and session end', () => {
    expect(translateGrokPostCompact({ ...base, trigger: 'auto' })).toMatchObject({
      kind: 'message',
      payload: { text: 'Grok context compacted (auto)' },
    });
    expect(translateGrokNotification({ ...base, message: 'Approve Bash' })).toMatchObject({
      kind: 'waiting-for-user',
      payload: { type: 'grok-terminal-notification', message: 'Approve Bash' },
    });
    expect(translateGrokStop({ ...base, stopReason: 'end_turn' })).toMatchObject({
      kind: 'finished',
      payload: { ok: true, subtype: 'success', stopReason: 'end_turn' },
    });
    expect(translateGrokStopFailure({ ...base, error: 'provider failed' })).toMatchObject({
      kind: 'finished',
      payload: { ok: false, subtype: 'error', error: 'provider failed' },
    });
    expect(translateGrokSessionEnd({ ...base, reason: 'exit' })).toMatchObject({
      kind: 'session-end',
      payload: { reason: 'exit' },
    });
  });
});
