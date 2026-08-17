import { describe, expect, it, vi } from 'vitest';
import type { CreateSessionOpts } from './_deps';
import { resolveCodexCreateRuntime } from './runtime-selection';

function opts(overrides: Partial<CreateSessionOpts> = {}): CreateSessionOpts {
  return { cwd: '/repo', prompt: 'run', ...overrides } as CreateSessionOpts;
}

describe('Codex live create runtime policy', () => {
  it('adopts persisted resume identity and avoids unused global readers', () => {
    const readDefaultSandbox = vi.fn(() => 'danger-full-access' as const);
    const readConfiguredReasoningEffort = vi.fn(() => 'low' as const);
    const readProviderConfigOverrides = vi.fn(() => ({
      model_context_window: 1_000_000,
    }));
    const resolved = resolveCodexCreateRuntime(opts({
      resume: 'application-id',
      developerInstructions: 'delegated',
    }), {
      resumeRecord: {
        cliSessionId: 'native-id',
        codexApprovalPolicy: 'never',
        codexSandbox: 'read-only',
        runtimeProvider: 'openrouter',
        thinking: 'max',
      },
      readApplicationInstructions: () => 'application',
      readConfiguredReasoningEffort,
      readProviderConfigOverrides,
      readDefaultSandbox,
    });

    expect(resolved).toMatchObject({
      approvalPolicy: 'never',
      developerInstructions: 'application\n\n---\n\ndelegated',
      effectiveResumeThreadId: 'native-id',
      provider: 'openrouter',
      providerConfigOverrides: { model_context_window: 1_000_000 },
      sandboxMode: 'read-only',
      threadModelReasoningEffort: 'max',
    });
    expect(resolved.effectiveOpts).toMatchObject({
      approvalPolicy: 'never',
      modelReasoningEffort: 'max',
      provider: 'openrouter',
    });
    expect(readDefaultSandbox).not.toHaveBeenCalled();
    expect(readConfiguredReasoningEffort).not.toHaveBeenCalled();
    expect(readProviderConfigOverrides).toHaveBeenCalledWith('openrouter');
  });

  it('uses current defaults for a new session while leaving native reasoning implicit', () => {
    const resolved = resolveCodexCreateRuntime(opts(), {
      resumeRecord: null,
      readApplicationInstructions: () => undefined,
      readConfiguredReasoningEffort: () => 'xhigh',
      readProviderConfigOverrides: () => null,
      readDefaultSandbox: () => 'workspace-write',
    });

    expect(resolved).toMatchObject({
      effectiveResumeThreadId: null,
      sandboxMode: 'workspace-write',
      threadModelReasoningEffort: undefined,
    });
    expect(resolved.effectiveOpts.modelReasoningEffort).toBe('xhigh');
  });

  it('starts a fresh provider thread while retaining persisted runtime choices', () => {
    const resolved = resolveCodexCreateRuntime(opts({
      resume: 'application-id',
      resumeMode: 'fresh-cli-reuse-app',
    }), {
      resumeRecord: {
        cliSessionId: 'old-native-id',
        codexApprovalPolicy: 'on-request',
        codexSandbox: 'read-only',
        runtimeProvider: 'team',
        thinking: null,
      },
      readApplicationInstructions: () => undefined,
      readConfiguredReasoningEffort: () => 'low',
      readProviderConfigOverrides: (provider) =>
        provider === 'team'
          ? { model_auto_compact_token_limit: 900_000 }
          : null,
      readDefaultSandbox: () => 'read-only',
    });

    expect(resolved.effectiveResumeThreadId).toBeNull();
    expect(resolved.provider).toBe('team');
    expect(resolved.providerConfigOverrides).toEqual({
      model_auto_compact_token_limit: 900_000,
    });
  });
});
