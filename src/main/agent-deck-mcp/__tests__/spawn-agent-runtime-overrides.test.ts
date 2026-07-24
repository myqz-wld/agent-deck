import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveClaudeAgentContent: vi.fn(),
  resolveCodexAgentContent: vi.fn(),
  getBundledAssetContent: vi.fn(),
  getBundledAgentRuntimeOverride: vi.fn(),
}));

vi.mock('@main/claude-config/custom-agents', () => ({
  resolveClaudeAgentContent: mocks.resolveClaudeAgentContent,
}));
vi.mock('@main/codex-config/custom-agents', () => ({
  resolveCodexAgentContent: mocks.resolveCodexAgentContent,
}));
vi.mock('@main/bundled-assets', () => ({
  getBundledAssetContent: mocks.getBundledAssetContent,
}));
vi.mock('@main/bundled-agent-runtime-overrides', () => ({
  getBundledAgentRuntimeOverride: mocks.getBundledAgentRuntimeOverride,
}));

import { resolveSpawnAgent } from '../tools/handlers/spawn-agent-resolver';

describe('spawn Agent bundled runtime overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBundledAgentRuntimeOverride.mockReturnValue({});
  });

  it('applies model and effort only to a bundled Claude Agent', () => {
    mocks.resolveClaudeAgentContent.mockReturnValue({
      ok: true,
      agent: {
        name: 'reviewer-claude',
        source: 'bundled',
        model: 'opus',
        effortLevel: 'xhigh',
        definition: {
          description: 'reviewer',
          prompt: 'review',
          model: 'opus',
          effort: 'xhigh',
        },
      },
    });
    mocks.getBundledAgentRuntimeOverride.mockReturnValue({
      model: 'custom-claude',
      thinking: 'high',
    });

    const result = resolveSpawnAgent(
      'reviewer-claude',
      'claude-code',
      '/repo',
    );
    expect(result).toMatchObject({
      ok: true,
      model: 'custom-claude',
      claudeCodeEffortLevel: 'high',
      claudeAgents: {
        'reviewer-claude': {
          model: 'custom-claude',
          effort: 'high',
        },
      },
    });
  });

  it('does not apply a bundled override to a project Claude Agent with the same name', () => {
    mocks.resolveClaudeAgentContent.mockReturnValue({
      ok: true,
      agent: {
        name: 'reviewer-claude',
        source: 'project',
        model: 'sonnet',
        effortLevel: 'medium',
        definition: {
          description: 'project reviewer',
          prompt: 'project review',
          model: 'sonnet',
          effort: 'medium',
        },
      },
    });

    const result = resolveSpawnAgent(
      'reviewer-claude',
      'claude-code',
      '/repo',
    );
    expect(result).toMatchObject({
      ok: true,
      model: 'sonnet',
      claudeCodeEffortLevel: 'medium',
    });
    expect(mocks.getBundledAgentRuntimeOverride).not.toHaveBeenCalled();
  });

  it('injects a bundled Codex provider through native model_provider config', () => {
    mocks.resolveCodexAgentContent.mockReturnValue({
      ok: true,
      agent: {
        name: 'reviewer-codex',
        source: 'bundled',
        sourcePath: '/plugin/reviewer-codex.toml',
        description: 'reviewer',
        developerInstructions: 'review',
        model: 'gpt-5.6-sol',
        modelReasoningEffort: 'xhigh',
        config: { feature: true },
      },
    });
    mocks.getBundledAgentRuntimeOverride.mockReturnValue({
      model: 'qw-pro-5',
      thinking: 'high',
      provider: 'fable',
    });

    expect(resolveSpawnAgent('reviewer-codex', 'codex-cli', '/repo')).toMatchObject({
      ok: true,
      model: 'qw-pro-5',
      modelReasoningEffort: 'high',
      codexConfigOverrides: {
        feature: true,
        model_provider: 'fable',
      },
    });
  });
});
