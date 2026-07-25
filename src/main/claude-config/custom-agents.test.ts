import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { settingsStore } from '@main/store/settings-store';
import { resolveClaudeAgentContent } from './custom-agents';

const { mockHome, bundledAgents } = vi.hoisted(() => ({
  mockHome: { value: '' },
  bundledAgents: new Map<string, string>(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

vi.mock('@main/bundled-assets', () => ({
  getBundledAssetContent: (_kind: 'agent' | 'skill', name: string) => {
    const content = bundledAgents.get(name);
    return content
      ? { ok: true, content }
      : { ok: false, reason: `bundled miss: ${name}` };
  },
}));

function writeAgent(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

describe('resolveClaudeAgentContent', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-claude-agents-'));
    mockHome.value = join(root, 'home');
    project = join(root, 'repo', 'pkg');
    mkdirSync(join(mockHome.value, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    bundledAgents.clear();
    settingsStore.set('injectAgentDeckClaudeAgents', true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads bundled agents before project and user agents', () => {
    bundledAgents.set(
      'reviewer-claude',
      [
        '---',
        'description: bundled reviewer',
        'model: opus',
        'tools: Read, Grep',
        'skills: agent-deck:simple-review',
        '---',
        'Bundled prompt.',
      ].join('\n'),
    );
    writeAgent(
      join(project, '.claude', 'agents', 'reviewer-claude.md'),
      '---\ndescription: project reviewer\nmodel: sonnet\n---\nProject prompt.',
    );

    const result = resolveClaudeAgentContent('reviewer-claude', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.source).toBe('bundled');
    expect(result.agent.model).toBe('opus');
    expect(result.agent.definition).toEqual({
      description: 'bundled reviewer',
      prompt: 'Bundled prompt.',
      tools: [
        'Read',
        'Grep',
        'mcp__agent-deck__send_message',
        'mcp__agent-deck__list_sessions',
      ],
      skills: ['agent-deck:simple-review'],
      model: 'opus',
    });
  });

  it('does not add reviewer messaging tools to ordinary Claude agents', () => {
    bundledAgents.set(
      'patcher',
      [
        '---',
        'description: bundled patcher',
        'tools: Read, Grep',
        '---',
        'Patch prompt.',
      ].join('\n'),
    );

    const result = resolveClaudeAgentContent('patcher', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.definition.tools).toEqual(['Read', 'Grep']);
  });

  it('loads the closest project-scoped agent before the user agent', () => {
    writeAgent(
      join(mockHome.value, '.claude', 'agents', 'patcher.md'),
      '---\ndescription: user patcher\nmodel: haiku\n---\nUser prompt.',
    );
    writeAgent(
      join(project, '.claude', 'agents', 'patcher.md'),
      '---\ndescription: project patcher\nmodel: sonnet\n---\nProject prompt.',
    );

    const result = resolveClaudeAgentContent('patcher', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.source).toBe('project');
    expect(result.agent.sourcePath).toBe(join(project, '.claude', 'agents', 'patcher.md'));
    expect(result.agent.model).toBe('sonnet');
    expect(result.agent.definition.prompt).toBe('Project prompt.');
  });

  it('loads a project Plugin Agent before a same-named user direct Agent', () => {
    const pluginRoot = join(project, '.claude', 'plugins', 'project-tools');
    writeAgent(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'project-tools', version: '1.0.0' }),
    );
    writeAgent(
      join(pluginRoot, 'agents', 'patcher.md'),
      '---\nname: patcher\ndescription: plugin patcher\nmodel: sonnet\n---\nPlugin prompt.',
    );
    writeAgent(
      join(mockHome.value, '.claude', 'agents', 'patcher.md'),
      '---\ndescription: user patcher\nmodel: haiku\n---\nUser prompt.',
    );

    const result = resolveClaudeAgentContent('patcher', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).toMatchObject({
      name: 'project-tools:patcher',
      source: 'plugin',
      sourcePath: realpathSync(join(pluginRoot, 'agents', 'patcher.md')),
      pluginDir: realpathSync(pluginRoot),
      model: 'sonnet',
      definition: { prompt: 'Plugin prompt.' },
    });
  });

  it('resolves a Claude Plugin Agent by native qualified name', () => {
    const pluginRoot = join(mockHome.value, '.claude', 'plugins', 'user-tools');
    writeAgent(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'user-tools', version: '1.0.0' }),
    );
    writeAgent(
      join(pluginRoot, 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: plugin reviewer\neffort: high\n---\nPlugin review.',
    );

    const result = resolveClaudeAgentContent('user-tools:reviewer', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).toMatchObject({
      name: 'user-tools:reviewer',
      source: 'plugin',
      pluginDir: realpathSync(pluginRoot),
      effortLevel: 'high',
    });
  });

  it('skips bundled agents when the Agent Deck Claude agents toggle is disabled', () => {
    bundledAgents.set(
      'reviewer-claude',
      '---\ndescription: bundled reviewer\nmodel: opus\n---\nBundled prompt.',
    );
    writeAgent(
      join(project, '.claude', 'agents', 'reviewer-claude.md'),
      '---\ndescription: project reviewer\nmodel: sonnet\n---\nProject prompt.',
    );
    settingsStore.set('injectAgentDeckClaudeAgents', false);

    const result = resolveClaudeAgentContent('reviewer-claude', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.source).toBe('project');
    expect(result.agent.model).toBe('sonnet');
    expect(result.agent.definition.prompt).toBe('Project prompt.');
  });

  it('parses frontmatter effort into definition.effort and effortLevel', () => {
    bundledAgents.set(
      'reviewer-claude',
      '---\ndescription: bundled reviewer\nmodel: opus\neffort: xhigh\n---\nBundled prompt.',
    );

    const result = resolveClaudeAgentContent('reviewer-claude', project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.effortLevel).toBe('xhigh');
    expect(result.agent.definition.effort).toBe('xhigh');
  });

  it('rejects invalid effort values instead of silently dropping them', () => {
    bundledAgents.set(
      'reviewer-claude',
      '---\ndescription: bundled reviewer\neffort: ultra\n---\nBundled prompt.',
    );

    const result = resolveClaudeAgentContent('reviewer-claude', project);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('invalid effort "ultra"');
  });

  it('rejects invalid agent names before file lookup', () => {
    const result = resolveClaudeAgentContent('../bad', project);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('invalid Claude agent name');
  });
});
