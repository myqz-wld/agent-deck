import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bundled-assets', () => ({
  __metaBuilders: {
    buildAgentMeta: (
      name: string,
      absPath: string,
      frontmatter: Record<string, string>,
      source: 'user',
      adapter: 'claude-code' | 'codex-cli',
    ) => ({
      kind: 'agent' as const,
      source,
      adapter,
      name,
      qualifiedName: name,
      description: frontmatter.description ?? '',
      provider: frontmatter.model_provider || undefined,
      absPath,
    }),
    buildSkillMeta: (
      name: string,
      absPath: string,
      frontmatter: Record<string, string>,
      source: 'user',
      adapter: 'claude-code' | 'codex-cli',
    ) => ({
      kind: 'skill' as const,
      source,
      adapter,
      name,
      qualifiedName: name,
      description: frontmatter.description ?? '',
      absPath,
    }),
  },
}));

import { getUserAssetPath, listUserAssets } from './user-assets';

describe('read-only user asset path resolution', () => {
  let root: string;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousGrokHome = process.env.GROK_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-user-assets-'));
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
    process.env.CODEX_HOME = join(root, 'codex');
    process.env.GROK_HOME = join(root, 'grok');
  });

  afterEach(() => {
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts native names and requires an exact path hint when one is supplied', () => {
    const name = 'Plugin.Agent_Name';
    const assetPath = join(process.env.CLAUDE_CONFIG_DIR!, 'agents', `${name}.md`);
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, 'agents'), { recursive: true });
    writeFileSync(assetPath, `---\nname: ${name}\ndescription: direct\n---\nBody`, 'utf8');

    expect(getUserAssetPath('agent', name, 'claude-code')).toBe(assetPath);
    expect(getUserAssetPath('agent', name, 'claude-code', join(root, 'missing.md'))).toBeNull();
  });

  it('classifies a Claude skills-dir plugin root once instead of duplicating it as a direct skill', () => {
    const pluginRoot = join(process.env.CLAUDE_CONFIG_DIR!, 'skills', 'demo-plugin');
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin' }),
      'utf8',
    );
    writeFileSync(
      join(pluginRoot, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: plugin root skill\n---\nBody',
      'utf8',
    );

    const normalizedSkillPath = join(realpathSync(pluginRoot), 'SKILL.md');
    const matches = listUserAssets().skills.filter((asset) =>
      asset.adapter === 'claude-code' && asset.absPath === normalizedSkillPath
    );
    expect(matches).toEqual([
      expect.objectContaining({
        origin: 'plugin',
        pluginName: 'demo-plugin',
        qualifiedName: 'plugin:demo-plugin/demo-skill',
      }),
    ]);
  });

  it('preserves a native Codex Agent model_provider in read-only metadata', () => {
    const agentRoot = join(process.env.CODEX_HOME!, 'agents');
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(
      join(agentRoot, 'reviewer.toml'),
      [
        'name = "reviewer"',
        'description = "provider metadata"',
        'model_provider = "native-team"',
      ].join('\n'),
      'utf8',
    );

    expect(
      listUserAssets().agents.find(
        (asset) => asset.adapter === 'codex-cli' && asset.name === 'reviewer',
      ),
    ).toMatchObject({ provider: 'native-team' });
  });
});
