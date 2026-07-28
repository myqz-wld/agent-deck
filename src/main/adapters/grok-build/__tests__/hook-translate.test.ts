import { describe, expect, it } from 'vitest';
import {
  normalizeGrokHookPrompt,
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
  modelId: 'grok-4.5',
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
      payload: {
        role: 'user',
        text: 'inspect this repository',
        rawText: 'inspect this repository',
      },
    });
  });

  it('strips exactly one canonical Grok user_query envelope and preserves raw text', () => {
    const wrapped =
      '<user_query>\n带我检查这个分支\n每段保留原文\n</user_query>';
    expect(
      translateGrokUserPrompt({
        ...base,
        hookEventName: 'UserPromptSubmit',
        prompt: wrapped,
      }),
    ).toMatchObject({
      kind: 'message',
      payload: {
        role: 'user',
        text: '带我检查这个分支\n每段保留原文',
        rawText: wrapped,
        metadata: { normalization: 'grok-user-query-envelope-v1' },
      },
    });
  });

  it('keeps user-authored nested tags and leaves ambiguous/non-canonical text untouched', () => {
    const nested =
      '<user_query>\n<user_query>\ninner\n</user_query>\n</user_query>';
    expect(normalizeGrokHookPrompt(nested)).toEqual({
      text: '<user_query>\ninner\n</user_query>',
      rawText: nested,
      normalizedBy: 'grok-user-query-envelope-v1',
    });

    for (const rawText of [
      '<user_query>verbatim</user_query>',
      'prefix\n<user_query>\nvalue\n</user_query>',
      '<user_query>\nvalue\n</user_query>\nsibling',
      '<user_query>\nnot closed',
    ]) {
      expect(normalizeGrokHookPrompt(rawText)).toEqual({ text: rawText, rawText });
    }
  });

  it('supports the canonical CRLF envelope without normalizing the inner newlines', () => {
    const rawText = '<user_query>\r\nline 1\r\nline 2\r\n</user_query>';
    expect(normalizeGrokHookPrompt(rawText)).toEqual({
      text: 'line 1\r\nline 2',
      rawText,
      normalizedBy: 'grok-user-query-envelope-v1',
    });
  });

  it('maps tool start, success, failure, and permission denial', () => {
    const tool = {
      ...base,
      toolName: 'Bash',
      toolInput: { command: 'false' },
      toolUseId: 'tool-1',
      toolInputTruncated: true,
      toolResultTruncated: true,
      durationMs: 1250,
    };
    expect(translateGrokPreToolUse(tool)).toMatchObject({
      kind: 'tool-use-start',
      payload: {
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputTruncated: true,
        durationMs: 1250,
      },
    });
    expect(
      translateGrokPostToolUse({ ...tool, toolOutput: { exitCode: 0 } }),
    ).toMatchObject({
      kind: 'tool-use-end',
      payload: {
        status: 'completed',
        toolResult: { exitCode: 0 },
        toolResultTruncated: true,
        durationMs: 1250,
      },
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
    expect(translateGrokNotification({
      ...base,
      notificationType: 'permission_prompt',
      message: 'Approve Bash',
    })).toMatchObject({
      kind: 'waiting-for-user',
      payload: { type: 'permission_prompt', message: 'Approve Bash' },
    });
    expect(translateGrokNotification({
      ...base,
      notificationType: 'auth_success',
      title: 'Signed in',
      message: 'Authentication complete',
      level: 'info',
    })).toMatchObject({
      kind: 'message',
      payload: {
        role: 'assistant',
        text: 'Authentication complete',
        metadata: {
          notification: true,
          notificationType: 'auth_success',
          title: 'Signed in',
          level: 'info',
        },
      },
    });
    expect(translateGrokStop({ ...base, stopReason: 'end_turn' })).toMatchObject([
      {
        kind: 'finished',
        payload: { ok: true, subtype: 'success', stopReason: 'end_turn' },
      },
    ]);
    expect(
      translateGrokStopFailure({ ...base, error: 'provider failed' }),
    ).toMatchObject([
      {
        kind: 'finished',
        payload: { ok: false, subtype: 'error', error: 'provider failed' },
      },
    ]);
    expect(translateGrokSessionEnd({ ...base, reason: 'exit' })).toMatchObject({
      kind: 'session-end',
      payload: { reason: 'exit' },
    });
  });

  it('emits the final assistant text before the Grok turn terminal event', () => {
    expect(
      translateGrokStop({
        ...base,
        lastAssistantMessage: 'Review complete.',
        backgroundTasks: [{ id: 'bg-1' }],
      }),
    ).toMatchObject([
      {
        kind: 'message',
        payload: { role: 'assistant', text: 'Review complete.' },
      },
      {
        kind: 'finished',
        payload: { backgroundTasks: [{ id: 'bg-1' }] },
      },
    ]);
  });
});
