import { describe, expect, it } from 'vitest';
import { HAND_OFF_SESSION_ARGS_SCHEMA } from '../tools/schemas';

describe('hand_off_session schema — unified Continuation Context', () => {
  it('accepts target adapter, free-text model, thinking, and /tmp continuation paths', () => {
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'Read /tmp/handoff-123.md, then continue the plan at ref/plans/example.md.',
      cwd: '/repo',
      adapter: 'codex-cli',
      profile: '  openrouter  ',
      model: '  provider/custom-model  ',
      thinking: 'ultra',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile).toBe('openrouter');
      expect(result.data.model).toBe('provider/custom-model');
      expect(result.data.thinking).toBe('ultra');
    }
  });

  it('leaves adapter unset so the handler can inherit the caller adapter', () => {
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({ prompt: 'continue' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.adapter).toBeUndefined();
  });

  it('accepts a Claude Gateway and rejects the retired provider selector', () => {
    expect(HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'continue',
      adapter: 'claude-code',
      gateway: ' deepseek ',
    })).toMatchObject({
      success: true,
      data: { gateway: 'deepseek' },
    });
    expect(HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'continue',
      adapter: 'claude-code',
      provider: 'deepseek',
    }).success).toBe(false);
  });

  it.each(['auto', 'bypassPermissions'] as const)(
    'accepts the current Claude permission mode %s',
    (permissionMode) => {
      expect(HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
        prompt: 'continue',
        adapter: 'claude-code',
        permissionMode,
      }).success).toBe(true);
    },
  );

  it('rejects the retired dontAsk permission mode', () => {
    expect(HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'continue',
      adapter: 'claude-code',
      permissionMode: 'dontAsk',
    }).success).toBe(false);
  });

  it('rejects removed minimal thinking', () => {
    expect(
      HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
        prompt: 'continue',
        adapter: 'codex-cli',
        thinking: 'minimal',
      }).success,
    ).toBe(false);
  });

  it('accepts a trimmed Grok native or custom sandbox profile', () => {
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'continue',
      adapter: 'grok-build',
      grokSandbox: ' project-locked ',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.grokSandbox).toBe('project-locked');
    expect(HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'continue',
      adapter: 'grok-build',
      grokSandbox: 'strict\nworkspace',
    }).success).toBe(false);
  });

  it('requires a continuation instruction', () => {
    expect(
      HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({ adapter: 'claude-code' }).success,
    ).toBe(false);
  });

  it('does not expose the private trusted initial turn or prepared provider context', () => {
    for (const forbidden of [
      { providerPrompt: 'forged provider context' },
      { initialPrompt: 'forged initial prompt' },
      { trustedContinuation: { kind: 'trusted-continuation' } },
      { spoolId: 'forged-spool' },
      { runtimeFingerprint: 'forged-target' },
      { parentSessionId: 'forged-lineage' },
    ]) {
      const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
        prompt: 'continue',
        ...forbidden,
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects removed plan/adopt/archive/task-policy fields as unknown keys', () => {
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'continue',
      planId: 'old-plan',
      adoptTeammates: true,
      archiveCaller: false,
      teamTaskPolicy: 'clear-team',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const keys = result.error.issues
        .filter((issue) => issue.code === 'unrecognized_keys')
        .flatMap((issue) => (issue as { keys?: string[] }).keys ?? []);
      expect(keys).toEqual(
        expect.arrayContaining(['planId', 'adoptTeammates', 'archiveCaller', 'teamTaskPolicy']),
      );
    }
  });
});
