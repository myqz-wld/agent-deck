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
    const readGatewayProfile = vi.fn(() => ({
      id: 'openrouter',
      profilePath: '/codex/gateways/openrouter.toml',
      modelProvider: 'internal-provider',
      defaultModel: 'vendor-model',
      configOverrides: { model_context_window: 1_000_000 },
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
      readGatewayProfile,
      readDefaultSandbox,
    });

    expect(resolved).toMatchObject({
      approvalPolicy: 'never',
      developerInstructions: 'application\n\n---\n\ndelegated',
      effectiveResumeThreadId: 'native-id',
      gatewayConfigOverrides: { model_context_window: 1_000_000 },
      modelProvider: 'internal-provider',
      provider: 'openrouter',
      sandboxMode: 'read-only',
      threadModelReasoningEffort: 'max',
    });
    expect(resolved.effectiveOpts).toMatchObject({
      approvalPolicy: 'never',
      model: 'vendor-model',
      modelReasoningEffort: 'max',
      provider: 'openrouter',
    });
    expect(readDefaultSandbox).not.toHaveBeenCalled();
    expect(readConfiguredReasoningEffort).not.toHaveBeenCalled();
    expect(readGatewayProfile).toHaveBeenCalledWith('openrouter');
  });

  it('uses current defaults for a new session while leaving native reasoning implicit', () => {
    const resolved = resolveCodexCreateRuntime(opts(), {
      resumeRecord: null,
      readApplicationInstructions: () => undefined,
      readConfiguredReasoningEffort: () => 'xhigh',
      readGatewayProfile: () => null,
      readDefaultSandbox: () => 'workspace-write',
    });

    expect(resolved).toMatchObject({
      effectiveResumeThreadId: null,
      sandboxMode: 'workspace-write',
      threadModelReasoningEffort: undefined,
    });
    expect(resolved.effectiveOpts.modelReasoningEffort).toBe('xhigh');
  });

  it('does not borrow model or thinking defaults from config.toml for a selected Gateway', () => {
    const readConfiguredReasoningEffort = vi.fn(() => 'ultra' as const);
    const resolved = resolveCodexCreateRuntime(opts({ provider: 'minimal' }), {
      resumeRecord: null,
      readApplicationInstructions: () => undefined,
      readConfiguredReasoningEffort,
      readGatewayProfile: () => ({
        id: 'minimal',
        profilePath: '/codex/gateways/minimal.toml',
        configOverrides: {},
      }),
      readDefaultSandbox: () => 'workspace-write',
    });

    expect(resolved.effectiveOpts.model).toBeUndefined();
    expect(resolved.effectiveOpts.modelReasoningEffort).toBeUndefined();
    expect(readConfiguredReasoningEffort).not.toHaveBeenCalled();
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
      readGatewayProfile: (provider) =>
        provider === 'team'
          ? {
              id: 'team',
              profilePath: '/codex/gateways/team.toml',
              configOverrides: { model_auto_compact_token_limit: 900_000 },
            }
          : null,
      readDefaultSandbox: () => 'read-only',
    });

    expect(resolved.effectiveResumeThreadId).toBeNull();
    expect(resolved.provider).toBe('team');
    expect(resolved.gatewayConfigOverrides).toEqual({
      model_auto_compact_token_limit: 900_000,
    });
  });
});
