import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const mockPluginRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

vi.mock('@main/adapters/codex-cli/codex-config-paths', () => ({
  getCodexAgentDeckPluginPath: () => mockPluginRoot.value,
}));

describe('resolveCodexAgentContent', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-agents-'));
    mockHome.value = join(root, 'home');
    mockPluginRoot.value = join(root, 'plugin');
    project = join(root, 'repo', 'packages', 'app');
    mkdirSync(join(mockHome.value, '.codex', 'agents'), { recursive: true });
    mkdirSync(join(mockPluginRoot.value, 'agents'), { recursive: true });
    mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads bundled TOML before project and user agents', async () => {
    writeAgent(join(mockPluginRoot.value, 'agents', 'reviewer-codex.toml'), {
      name: 'reviewer-codex',
      description: 'Bundled reviewer',
      body: 'Use bundled instructions.',
      model: 'gpt-5.5',
      effort: 'high',
      sandbox: 'read-only',
    });
    writeAgent(join(project, '.codex', 'agents', 'reviewer-codex.toml'), {
      name: 'reviewer-codex',
      description: 'Project override',
      body: 'Use project instructions.',
    });

    const { resolveCodexAgentContent } = await import('./custom-agents');
    const result = resolveCodexAgentContent('reviewer-codex', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).toMatchObject({
      name: 'reviewer-codex',
      source: 'bundled',
      description: 'Bundled reviewer',
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
      sandboxMode: 'read-only',
    });
    expect(result.agent.developerInstructions).toContain('Use bundled instructions.');
  });

  it.each(['max', 'ultra'] as const)(
    'accepts current Codex model_reasoning_effort %s from custom-agent TOML',
    async (effort) => {
      writeAgent(join(project, '.codex', 'agents', `effort-${effort}.toml`), {
        name: `effort-${effort}`,
        description: `${effort} effort agent`,
        body: 'Use the requested effort.',
        effort,
      });

      const { resolveCodexAgentContent } = await import('./custom-agents');
      const result = resolveCodexAgentContent(`effort-${effort}`, project);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.agent.modelReasoningEffort).toBe(effort);
    },
  );

  it.each(['minimal', 'extreme'])('rejects unsupported Codex effort %s instead of guessing support', async (effort) => {
    writeAgent(join(mockHome.value, '.codex', 'agents', 'future-effort.toml'), {
      name: 'future-effort',
      description: 'Future effort agent',
      body: 'Use a future effort.',
      effort,
    });

    const { getUserCodexAgentContent } = await import('./custom-agents');
    const result = getUserCodexAgentContent('future-effort');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`invalid model_reasoning_effort "${effort}"`);
  });

  it('skips bundled TOML when the Agent Deck Codex agents toggle is disabled', async () => {
    writeAgent(join(mockPluginRoot.value, 'agents', 'reviewer-codex.toml'), {
      name: 'reviewer-codex',
      description: 'Bundled reviewer',
      body: 'Use bundled instructions.',
      model: 'gpt-5.5',
    });
    writeAgent(join(project, '.codex', 'agents', 'reviewer-codex.toml'), {
      name: 'reviewer-codex',
      description: 'Project reviewer',
      body: 'Use project instructions.',
      model: 'gpt-5.4',
    });

    const { settingsStore } = await import('@main/store/settings-store');
    settingsStore.set('injectAgentDeckCodexAgents', false);
    const { resolveCodexAgentContent } = await import('./custom-agents');
    const result = resolveCodexAgentContent('reviewer-codex', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).toMatchObject({
      name: 'reviewer-codex',
      source: 'project',
      description: 'Project reviewer',
      model: 'gpt-5.4',
    });
    expect(result.agent.developerInstructions).toContain('Use project instructions.');
  });

  it('loads the closest project-scoped agent before the user agent', async () => {
    writeAgent(join(mockHome.value, '.codex', 'agents', 'patcher.toml'), {
      name: 'patch-coder',
      description: 'User patcher',
      body: 'Use user instructions.',
    });
    writeAgent(join(project, '.codex', 'agents', 'patcher.toml'), {
      name: 'patch-coder',
      description: 'Project patcher',
      body: 'Use project instructions.',
    });

    const { resolveCodexAgentContent } = await import('./custom-agents');
    const result = resolveCodexAgentContent('patch-coder', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.source).toBe('project');
    expect(result.agent.sourcePath).toBe(join(project, '.codex', 'agents', 'patcher.toml'));
    expect(result.agent.developerInstructions).toContain('Use project instructions.');
  });

  it('uses TOML name as source of truth and does not fall back to filename stem', async () => {
    writeAgent(join(mockHome.value, '.codex', 'agents', 'prompt-editor.toml'), {
      name: 'internal-name',
      description: 'Prompt editor',
      body: 'Edit prompt assets.',
    });

    const { getUserCodexAgentContent } = await import('./custom-agents');
    const result = getUserCodexAgentContent('prompt-editor');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('not found');
  });

  it('keeps nested config tables such as skills.config available for thread config merging', async () => {
    writeFileSync(
      join(mockHome.value, '.codex', 'agents', 'skill-filter.toml'),
      [
        'name = "skill-filter"',
        'description = "Filters a skill"',
        'developer_instructions = "Use the configured skill set."',
        '[[skills.config]]',
        'path = "/tmp/example/SKILL.md"',
        'enabled = false',
      ].join('\n'),
      'utf8',
    );

    const { getUserCodexAgentContent } = await import('./custom-agents');
    const result = getUserCodexAgentContent('skill-filter');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.config).toEqual({
      skills: {
        config: [{ path: '/tmp/example/SKILL.md', enabled: false }],
      },
    });
  });
});

function writeAgent(
  path: string,
  input: {
    name: string;
    description: string;
    body: string;
    model?: string;
    effort?: string;
    sandbox?: string;
  },
): void {
  const lines = [
    `name = "${input.name}"`,
    `description = "${input.description}"`,
    input.model ? `model = "${input.model}"` : undefined,
    input.effort ? `model_reasoning_effort = "${input.effort}"` : undefined,
    input.sandbox ? `sandbox_mode = "${input.sandbox}"` : undefined,
    'developer_instructions = """',
    input.body,
    '"""',
  ].filter((line): line is string => Boolean(line));
  writeFileSync(path, lines.join('\n'), 'utf8');
}
