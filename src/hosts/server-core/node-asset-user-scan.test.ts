import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanServerCoreUserAssets } from './node-asset-user-scan';

describe('scanServerCoreUserAssets bounds', () => {
  it('stops nested plugin discovery at the shared traversal budget', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-deck-node-asset-budget-'));
    try {
      const plugins = join(home, '.claude', 'plugins');
      for (let index = 0; index < 20; ++index) {
        mkdirSync(join(plugins, `empty-${index}`, 'nested'), { recursive: true });
      }

      const result = scanServerCoreUserAssets(home, {
        maxAssets: 10,
        maxVisitedEntries: 5,
      });

      expect(result.assets).toEqual([]);
      expect(result.truncated).toBe(true);
      expect(result.visitedEntries).toBeGreaterThan(0);
      expect(result.visitedEntries).toBeLessThanOrEqual(5);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  it('never catalogs sensitive leaves or manifest-indirected secret directories', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-deck-node-asset-sensitive-'));
    try {
      const agents = join(home, '.codex', 'agents');
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, 'reviewer.toml'), [
        'name = "reviewer"',
        'description = "safe"',
      ].join('\n'));
      writeFileSync(join(agents, 'credentials.toml'), [
        'name = "credentials"',
        'api_key = "sk-secretmarker123"',
      ].join('\n'));
      writeFileSync(join(agents, 'config.toml'), [
        'name = "config"',
        'api_key = "sk-secretmarker123"',
      ].join('\n'));

      const plugin = join(home, '.claude', 'plugins', 'secret-plugin');
      mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
      mkdirSync(join(plugin, 'secrets'), { recursive: true });
      writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: 'secret-plugin',
        agents: 'secrets',
      }));
      writeFileSync(join(plugin, 'secrets', 'leak.md'), [
        '---', 'name: leak', '---', 'apiToken: sk-secretmarker123',
      ].join('\n'));

      const result = scanServerCoreUserAssets(home, {
        maxAssets: 20,
        maxVisitedEntries: 100,
      });
      expect(result.assets.map((asset) => asset.name)).toContain('reviewer');
      expect(result.assets.map((asset) => asset.name)).not.toContain('credentials');
      expect(result.assets.map((asset) => asset.name)).not.toContain('config');
      expect(JSON.stringify(result.assets)).not.toContain('secretmarker');
      expect(JSON.stringify(result.assets)).not.toContain('leak');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  it('uses installed Plugin roots for Grok instead of historical Claude cache versions', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-deck-node-asset-grok-plugins-'));
    try {
      const claudePlugins = join(home, '.claude', 'plugins');
      const stale = join(claudePlugins, 'cache', 'market', 'demo', '1.0.0');
      const active = join(claudePlugins, 'cache', 'market', 'demo', '2.0.0');
      for (const root of [stale, active]) {
        mkdirSync(join(root, '.claude-plugin'), { recursive: true });
        mkdirSync(join(root, 'skills', 'audit'), { recursive: true });
        writeFileSync(
          join(root, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'demo' }),
        );
        writeFileSync(
          join(root, 'skills', 'audit', 'SKILL.md'),
          '---\nname: audit\ndescription: audit\n---\n',
        );
      }
      writeFileSync(
        join(claudePlugins, 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: { 'demo@market': [{ installPath: active, version: '2.0.0' }] },
        }),
      );

      const grokPlugin = join(home, '.grok', 'installed-plugins', 'grok-demo-repo');
      mkdirSync(join(grokPlugin, '.grok-plugin'), { recursive: true });
      mkdirSync(join(grokPlugin, 'skills', 'ship'), { recursive: true });
      writeFileSync(
        join(grokPlugin, '.grok-plugin', 'plugin.json'),
        JSON.stringify({ name: 'grok-demo' }),
      );
      writeFileSync(
        join(grokPlugin, 'skills', 'ship', 'SKILL.md'),
        '---\nname: ship\ndescription: ship\n---\n',
      );
      writeFileSync(
        join(home, '.grok', 'installed-plugins', 'registry.json'),
        JSON.stringify({
          version: 1,
          repos: {
            demo: {
              path: grokPlugin,
              plugins: { 'grok-demo': { version: '1.0.0' } },
            },
          },
        }),
      );

      const result = scanServerCoreUserAssets(home, {
        maxAssets: 50,
        maxVisitedEntries: 500,
      });
      const grokPluginSkills = result.assets.filter((asset) =>
        asset.adapter === 'grok-build' && asset.kind === 'skill' && asset.origin === 'plugin'
      );
      expect(grokPluginSkills).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pluginName: 'demo',
          qualifiedName: 'plugin:demo/audit',
          absPath: expect.stringContaining(join('2.0.0', 'skills', 'audit', 'SKILL.md')),
        }),
        expect.objectContaining({
          pluginName: 'grok-demo',
          qualifiedName: 'plugin:grok-demo/ship',
        }),
      ]));
      expect(grokPluginSkills).toHaveLength(2);
      expect(grokPluginSkills.some((asset) =>
        asset.absPath.includes(join('1.0.0', 'skills', 'audit'))
      )).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  it('retains every adapter when one Provider Home category exceeds the response cap', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-deck-node-asset-fair-'));
    try {
      const claude = join(home, '.claude', 'agents');
      const codex = join(home, '.codex', 'agents');
      const grok = join(home, '.grok', 'agents');
      mkdirSync(claude, { recursive: true });
      mkdirSync(codex, { recursive: true });
      mkdirSync(grok, { recursive: true });
      for (let index = 0; index < 520; index += 1) {
        writeFileSync(join(claude, `claude-${index}.md`), [
          '---', `name: claude-${index}`, 'description: safe', '---',
        ].join('\n'));
      }
      writeFileSync(join(codex, 'codex.toml'), 'name = "codex"\ndescription = "safe"\n');
      writeFileSync(join(grok, 'grok.md'), '---\nname: grok\ndescription: safe\n---\n');

      const result = scanServerCoreUserAssets(home, {
        maxAssets: 512,
        maxVisitedEntries: 4_000,
      });
      expect(result.assets).toHaveLength(512);
      expect(result.truncated).toBe(true);
      expect(new Set(result.assets.map((asset) => asset.adapter))).toEqual(new Set([
        'claude-code', 'codex-cli', 'grok-build',
      ]));
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
