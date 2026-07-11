import { describe, expect, it } from 'vitest';
import { HAND_OFF_SESSION_ARGS_SCHEMA } from '../tools/schemas';

describe('hand_off_session schema — unified Continuation Context', () => {
  it('accepts target adapter, free-text model, thinking, and /tmp continuation paths', () => {
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      prompt: 'Read /tmp/handoff-123.md, then continue the plan at ref/plans/example.md.',
      cwd: '/repo',
      adapter: 'codex-cli',
      model: '  provider/custom-model  ',
      thinking: 'ultra',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('provider/custom-model');
      expect(result.data.thinking).toBe('ultra');
    }
  });

  it('leaves adapter unset so the handler can inherit the caller adapter', () => {
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({ prompt: 'continue' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.adapter).toBeUndefined();
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
