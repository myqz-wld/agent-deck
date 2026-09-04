import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getClaudePluginAssetPath,
  resolveClaudeProjectPluginAgentContent,
  resolveClaudeUserPluginAgentContent,
} from './plugin-assets';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writePlugin(root: string, pluginName: string, agentName: string): void {
  write(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
  );
  write(
    join(root, 'agents', `${agentName}.md`),
    `---\nname: ${agentName}\ndescription: ${agentName} agent\nmodel: sonnet\n---\n${agentName} prompt`,
  );
  write(
    join(root, 'skills', 'plugin-skill', 'SKILL.md'),
    '---\nname: plugin-skill\ndescription: plugin skill\n---\nPlugin skill body',
  );
}

describe('Claude Plugin assets', () => {
  let root: string;
  let configRoot: string;
  let projectRoot: string;
  const previousConfigRoot = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-claude-plugins-'));
    configRoot = join(root, 'claude-home');
    projectRoot = join(root, 'repo', 'package');
    process.env.CLAUDE_CONFIG_DIR = configRoot;
  });

  afterEach(() => {
    if (previousConfigRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves installed Plugin Agent and Skill paths', () => {
    const pluginRoot = join(configRoot, 'plugins', 'cache', 'demo', '1.0.0');
    writePlugin(pluginRoot, 'demo', 'plugin-agent');
    write(
      join(configRoot, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'demo@personal': [{ installPath: pluginRoot }] } }),
    );

    const agentPath = join(pluginRoot, 'agents', 'plugin-agent.md');
    const skillPath = join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md');
    expect(getClaudePluginAssetPath('agent', 'plugin-agent')).toBe(realpathSync(agentPath));
    expect(getClaudePluginAssetPath('skill', 'plugin-skill')).toBe(realpathSync(skillPath));
    expect(getClaudePluginAssetPath('agent', 'plugin-agent', agentPath))
      .toBe(realpathSync(agentPath));
    expect(getClaudePluginAssetPath('agent', 'plugin-agent', join(root, 'missing.md')))
      .toBeNull();
  });

  it('discovers skills-dir plugins, root skills, and custom component paths', () => {
    const pluginRoot = join(configRoot, 'skills', 'skills-dir-demo');
    write(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'skills-dir-demo',
        agents: ['./components/agents'],
        skills: ['./components/skills'],
      }),
    );
    write(
      join(pluginRoot, 'SKILL.md'),
      '---\nname: root-skill\ndescription: >-\n  Root plugin skill\n  description.\n---\nRoot skill body',
    );
    write(
      join(pluginRoot, 'components', 'agents', 'custom-agent.md'),
      '---\nname: custom-agent\ndescription: custom agent\n---\nCustom agent body',
    );
    write(
      join(pluginRoot, 'components', 'skills', 'custom-skill', 'SKILL.md'),
      '---\nname: custom-skill\ndescription: custom skill\n---\nCustom skill body',
    );

    expect(getClaudePluginAssetPath('agent', 'custom-agent')).toBe(realpathSync(
      join(pluginRoot, 'components', 'agents', 'custom-agent.md'),
    ));
    expect(getClaudePluginAssetPath('skill', 'root-skill')).toBe(realpathSync(
      join(pluginRoot, 'SKILL.md'),
    ));
    expect(getClaudePluginAssetPath('skill', 'custom-skill')).toBe(realpathSync(
      join(pluginRoot, 'components', 'skills', 'custom-skill', 'SKILL.md'),
    ));
  });

  it('resolves project and user Plugin Agents by native qualified name', () => {
    const userPlugin = join(configRoot, 'plugins', 'user-demo');
    const projectPlugin = join(projectRoot, '.claude', 'skills', 'project-demo');
    writePlugin(userPlugin, 'user-demo', 'reviewer');
    writePlugin(projectPlugin, 'project-demo', 'reviewer');

    expect(resolveClaudeProjectPluginAgentContent('project-demo:reviewer', projectRoot))
      .toMatchObject({
        ok: true,
        agent: {
          runtimeName: 'project-demo:reviewer',
          pluginDir: realpathSync(projectPlugin),
        },
      });
    expect(resolveClaudeUserPluginAgentContent('user-demo:reviewer')).toMatchObject({
      ok: true,
      agent: {
        runtimeName: 'user-demo:reviewer',
        pluginDir: realpathSync(userPlugin),
      },
    });
  });

  it('rejects ambiguous unqualified Plugin Agent names', () => {
    writePlugin(join(configRoot, 'plugins', 'alpha'), 'alpha', 'reviewer');
    writePlugin(join(configRoot, 'plugins', 'beta'), 'beta', 'reviewer');

    const result = resolveClaudeUserPluginAgentContent('reviewer');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('multiple Claude plugin agents');
    expect(result.reason).toContain('alpha:reviewer');
    expect(result.reason).toContain('beta:reviewer');
  });
});
