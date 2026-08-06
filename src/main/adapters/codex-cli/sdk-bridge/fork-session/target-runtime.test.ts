import { describe, expect, it } from 'vitest';
import type { CreateSessionOpts } from '../create-session/_deps';
import { resolveCodexForkTargetRuntime } from './target-runtime';

function target(overrides: Partial<CreateSessionOpts> = {}): CreateSessionOpts {
  return {
    prompt: 'delegate this task',
    cwd: '/repo',
    ...overrides,
  } as CreateSessionOpts;
}

describe('Codex fork target runtime boundary', () => {
  it('uses the injected host defaults without discovering desktop settings', () => {
    const runtime = resolveCodexForkTargetRuntime(target({
      developerInstructions: 'delegated instructions',
    }), {
      defaultSandboxMode: 'read-only',
      developerInstructions: 'application instructions',
      readConfiguredModel: () => 'gpt-configured',
      readConfiguredReasoningEffort: () => 'max',
    });

    expect(runtime).toMatchObject({
      cwd: '/repo',
      sandboxMode: 'read-only',
      persistedModel: 'gpt-configured',
      persistedReasoningEffort: 'max',
      effectiveDeveloperInstructions:
        'application instructions\n\n---\n\ndelegated instructions',
    });
    expect(runtime.threadOptions).toMatchObject({
      workingDirectory: '/repo',
      sandboxMode: 'read-only',
    });
    expect(runtime.threadOptions).not.toHaveProperty('model');
    expect(runtime.threadOptions).not.toHaveProperty('modelReasoningEffort');
  });

  it('keeps explicit per-session sandbox, model, and reasoning values authoritative', () => {
    const runtime = resolveCodexForkTargetRuntime(target({
      codexSandbox: 'danger-full-access',
      model: 'gpt-explicit',
      modelReasoningEffort: 'ultra',
    }), {
      defaultSandboxMode: 'read-only',
      readConfiguredModel: () => 'gpt-configured',
      readConfiguredReasoningEffort: () => 'low',
    });

    expect(runtime).toMatchObject({
      sandboxMode: 'danger-full-access',
      persistedModel: 'gpt-explicit',
      persistedReasoningEffort: 'ultra',
    });
    expect(runtime.threadOptions).toMatchObject({
      sandboxMode: 'danger-full-access',
      model: 'gpt-explicit',
      modelReasoningEffort: 'ultra',
    });
  });
});
