import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getGrokUserAssetPath,
  listGrokUserAssets,
  resolveGrokUserAgentContent,
} from '../custom-assets';

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function agent(description: string): string {
  return `---\nname: ${description}\ndescription: ${description}\neffort: high\n---\n# ${description}`;
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}`;
}

describe('Grok custom assets', () => {
  let grokHome: string;
  let userHome: string;
  let projectRoot: string;
  const previousGrokHome = process.env.GROK_HOME;
  const previousHome = process.env.HOME;

  beforeEach(() => {
    grokHome = mkdtempSync(join(tmpdir(), 'agent-deck-grok-assets-home-'));
    userHome = mkdtempSync(join(tmpdir(), 'agent-deck-grok-assets-user-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'agent-deck-grok-assets-project-'));
    process.env.GROK_HOME = grokHome;
    process.env.HOME = userHome;
  });

  afterEach(() => {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(grokHome, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('resolves project agents before user agents and supports project plugins', () => {
    writeFile(join(projectRoot, '.grok', 'agents', 'project-agent.md'), agent('project-agent'));
    writeFile(
      join(projectRoot, '.grok', 'plugins', 'project-plugin', 'plugin.json'),
      '{"name":"project-plugin"}',
    );
    writeFile(
      join(projectRoot, '.grok', 'plugins', 'project-plugin', 'agents', 'plugin-agent.md'),
      agent('plugin-agent'),
    );
    writeFile(join(grokHome, 'agents', 'user-agent.md'), agent('user-agent'));

    expect(resolveGrokUserAgentContent('project-agent', projectRoot)).toMatchObject({
      ok: true,
      agent: { source: 'project', name: 'project-agent' },
    });
    expect(resolveGrokUserAgentContent('plugin-agent', projectRoot)).toMatchObject({
      ok: true,
      agent: { source: 'plugin', name: 'plugin-agent', pluginDir: expect.stringContaining('project-plugin') },
    });
    expect(resolveGrokUserAgentContent('project-plugin:plugin-agent', projectRoot)).toMatchObject({
      ok: true,
      agent: { source: 'plugin', name: 'plugin-agent', pluginDir: expect.stringContaining('project-plugin') },
    });
    expect(resolveGrokUserAgentContent('user-agent', projectRoot)).toMatchObject({
      ok: true,
      agent: { source: 'user', name: 'user-agent' },
    });
  });

  it('lists direct user assets and plugin components with plugin-qualified names', () => {
    writeFile(join(grokHome, 'agents', 'User.Agent.md'), agent('User.Agent'));
    writeFile(join(grokHome, 'skills', 'user-skill', 'SKILL.md'), skill('user-skill'));
    writeFile(join(grokHome, 'plugins', 'demo', 'plugin.json'), '{"name":"demo"}');
    writeFile(join(grokHome, 'plugins', 'demo', 'agents', 'plugin-agent.md'), agent('plugin-agent'));
    writeFile(join(grokHome, 'plugins', 'demo', 'skills', 'plugin-skill', 'SKILL.md'), skill('plugin-skill'));

    const snapshot = listGrokUserAssets();
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'User.Agent', absPath: expect.stringContaining('User.Agent.md') }),
        expect.objectContaining({
          name: 'plugin-agent',
          qualifiedName: 'plugin:demo/plugin-agent',
          runtimeName: 'demo:plugin-agent',
        }),
      ]),
    );
    expect(snapshot.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'user-skill' }),
        expect.objectContaining({
          name: 'plugin-skill',
          qualifiedName: 'plugin:demo/plugin-skill',
        }),
      ]),
    );
  });

  it('lists only effective Plugin versions from Grok and Claude install state', () => {
    const claudePlugins = join(userHome, '.claude', 'plugins');
    const staleClaude = join(
      claudePlugins,
      'cache',
      'market',
      'market-plugin',
      '1.0.0',
    );
    const activeClaude = join(
      claudePlugins,
      'cache',
      'market',
      'market-plugin',
      '2.0.0',
    );
    for (const root of [staleClaude, activeClaude]) {
      writeFile(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'market-plugin' }),
      );
      writeFile(
        join(root, 'skills', 'market-skill', 'SKILL.md'),
        skill('market-skill'),
      );
    }
    writeFile(
      join(claudePlugins, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'market-plugin@market': [{ installPath: activeClaude, version: '2.0.0' }],
        },
      }),
    );

    const activeGrok = join(grokHome, 'installed-plugins', 'active-repo');
    const disabledGrok = join(grokHome, 'installed-plugins', 'disabled-repo');
    writeFile(
      join(activeGrok, '.grok-plugin', 'plugin.json'),
      JSON.stringify({ name: 'grok-active' }),
    );
    writeFile(
      join(activeGrok, 'skills', 'active-skill', 'SKILL.md'),
      skill('active-skill'),
    );
    writeFile(
      join(disabledGrok, '.grok-plugin', 'plugin.json'),
      JSON.stringify({ name: 'grok-disabled' }),
    );
    writeFile(
      join(disabledGrok, 'skills', 'disabled-skill', 'SKILL.md'),
      skill('disabled-skill'),
    );
    writeFile(join(grokHome, 'config.toml'), '[plugins]\nenabled = ["grok-active"]\n');
    writeFile(
      join(grokHome, 'installed-plugins', 'registry.json'),
      JSON.stringify({
        version: 1,
        repos: {
          active: { path: activeGrok, plugins: { 'grok-active': { version: '1.0.0' } } },
          disabled: {
            path: disabledGrok,
            plugins: { 'grok-disabled': { version: '1.0.0' } },
          },
        },
      }),
    );

    const pluginSkills = listGrokUserAssets().skills.filter((asset) => asset.origin === 'plugin');
    expect(pluginSkills).toHaveLength(2);
    expect(pluginSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginName: 'market-plugin',
        qualifiedName: 'plugin:market-plugin/market-skill',
        absPath: expect.stringContaining(
          join('2.0.0', 'skills', 'market-skill', 'SKILL.md'),
        ),
      }),
      expect.objectContaining({
        pluginName: 'grok-active',
        qualifiedName: 'plugin:grok-active/active-skill',
      }),
    ]));
    expect(pluginSkills.some((asset) =>
      asset.absPath.includes(join('1.0.0', 'skills', 'market-skill'))
    )).toBe(false);
    expect(pluginSkills.some((asset) => asset.pluginName === 'grok-disabled')).toBe(false);
  });

  it('folds multiline descriptions instead of exposing the YAML marker', () => {
    writeFile(
      join(grokHome, 'skills', 'folded-skill', 'SKILL.md'),
      '---\nname: folded-skill\ndescription: >-\n  First description line\n  continues here.\n---\nBody',
    );

    expect(listGrokUserAssets().skills).toEqual([
      expect.objectContaining({
        name: 'folded-skill',
        description: 'First description line continues here.',
      }),
    ]);
  });

  it('accepts direct and plugin path hints for read-only inspection', () => {
    const pluginAgent = join(grokHome, 'plugins', 'demo', 'agents', 'plugin-agent.md');
    const userAgent = join(grokHome, 'agents', 'user-agent.md');
    writeFile(join(grokHome, 'plugins', 'demo', 'plugin.json'), '{"name":"demo"}');
    writeFile(pluginAgent, agent('plugin-agent'));
    writeFile(userAgent, agent('user-agent'));

    expect(getGrokUserAssetPath('agent', 'plugin-agent', pluginAgent)).toBe(pluginAgent);
    expect(getGrokUserAssetPath('agent', 'user-agent', userAgent)).toBe(userAgent);
    expect(getGrokUserAssetPath('agent', 'user-agent', join(grokHome, 'missing.md'))).toBeNull();
  });

  it('rejects ambiguous unqualified Plugin Agent names', () => {
    writeFile(join(grokHome, 'plugins', 'alpha', 'plugin.json'), '{"name":"alpha"}');
    writeFile(join(grokHome, 'plugins', 'alpha', 'agents', 'reviewer.md'), agent('reviewer'));
    writeFile(join(grokHome, 'plugins', 'beta', 'plugin.json'), '{"name":"beta"}');
    writeFile(join(grokHome, 'plugins', 'beta', 'agents', 'reviewer.md'), agent('reviewer'));

    const result = resolveGrokUserAgentContent('reviewer', projectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('multiple Grok plugin agents');
    expect(result.reason).toContain('alpha:reviewer');
    expect(result.reason).toContain('beta:reviewer');
  });
});
