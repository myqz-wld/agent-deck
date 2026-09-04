import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getCodexPluginAssetPath,
  resolveCodexProjectPluginAgentContent,
  resolveCodexUserPluginAgentContent,
} from './plugin-assets';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writePlugin(root: string, pluginName: string, agentName: string): void {
  write(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
  );
  write(
    join(root, 'agents', `${agentName}.toml`),
    [
      `name = "${agentName}"`,
      `description = "${agentName} agent"`,
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"',
      'developer_instructions = "Run the Plugin Agent."',
    ].join('\n'),
  );
  write(
    join(root, 'skills', 'plugin-skill', 'SKILL.md'),
    '---\nname: plugin-skill\ndescription: plugin skill\n---\nPlugin skill body',
  );
}

describe('Codex Plugin assets', () => {
  let root: string;
  let codexHome: string;
  let projectRoot: string;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-plugins-'));
    codexHome = join(root, 'codex-home');
    projectRoot = join(root, 'repo', 'package');
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = join(root, 'home');
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves native Plugin Skill and Agent paths', () => {
    const pluginRoot = join(codexHome, 'plugins', 'cache', 'demo', '1.0.0');
    writePlugin(pluginRoot, 'demo', 'plugin-agent');

    const agentPath = join(pluginRoot, 'agents', 'plugin-agent.toml');
    const skillPath = join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md');
    expect(getCodexPluginAssetPath('agent', 'plugin-agent')).toBe(realpathSync(agentPath));
    expect(getCodexPluginAssetPath('skill', 'plugin-skill')).toBe(realpathSync(skillPath));
    expect(getCodexPluginAssetPath('skill', 'plugin-skill', skillPath))
      .toBe(realpathSync(skillPath));
    expect(getCodexPluginAssetPath('skill', 'plugin-skill', join(root, 'missing', 'SKILL.md')))
      .toBeNull();
  });

  it('resolves project and user Plugin Agents by qualified name', () => {
    const userPlugin = join(codexHome, 'plugins', 'user-demo');
    const projectPlugin = join(projectRoot, '.codex', 'plugins', 'project-demo');
    writePlugin(userPlugin, 'user-demo', 'reviewer');
    writePlugin(projectPlugin, 'project-demo', 'reviewer');

    expect(resolveCodexProjectPluginAgentContent('project-demo:reviewer', projectRoot))
      .toMatchObject({
        ok: true,
        agent: {
          runtimeName: 'project-demo:reviewer',
          pluginDir: realpathSync(projectPlugin),
          parsed: { developerInstructions: 'Run the Plugin Agent.' },
        },
      });
    expect(resolveCodexUserPluginAgentContent('user-demo:reviewer')).toMatchObject({
      ok: true,
      agent: {
        runtimeName: 'user-demo:reviewer',
        pluginDir: realpathSync(userPlugin),
      },
    });
  });

  it('discovers personal marketplace Plugin roots under ~/.agents/plugins', () => {
    const pluginRoot = join(process.env.HOME!, '.agents', 'plugins', 'plugins', 'personal-demo');
    writePlugin(pluginRoot, 'personal-demo', 'personal-agent');

    expect(resolveCodexUserPluginAgentContent('personal-demo:personal-agent')).toMatchObject({
      ok: true,
      agent: {
        name: 'personal-agent',
        pluginName: 'personal-demo',
        runtimeName: 'personal-demo:personal-agent',
      },
    });
  });

  it('rejects ambiguous unqualified Plugin Agent names', () => {
    writePlugin(join(codexHome, 'plugins', 'alpha'), 'alpha', 'reviewer');
    writePlugin(join(codexHome, 'plugins', 'beta'), 'beta', 'reviewer');

    const result = resolveCodexUserPluginAgentContent('reviewer');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('multiple Codex plugin agents');
    expect(result.reason).toContain('alpha:reviewer');
    expect(result.reason).toContain('beta:reviewer');
  });
});
