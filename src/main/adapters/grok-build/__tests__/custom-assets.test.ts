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
  let projectRoot: string;
  const previousGrokHome = process.env.GROK_HOME;

  beforeEach(() => {
    grokHome = mkdtempSync(join(tmpdir(), 'agent-deck-grok-assets-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'agent-deck-grok-assets-project-'));
    process.env.GROK_HOME = grokHome;
  });

  afterEach(() => {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    rmSync(grokHome, { recursive: true, force: true });
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
